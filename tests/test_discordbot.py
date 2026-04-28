from pathlib import Path

from discordbot import build_get_response, get_required_env, read_tunnel_url


def test_read_tunnel_url_returns_trimmed_url(tmp_path: Path):
    tunnel_file = tmp_path / "cloudflared_url.txt"
    tunnel_file.write_text("https://demo.trycloudflare.com\n", encoding="utf-8")

    assert read_tunnel_url(tunnel_file) == "https://demo.trycloudflare.com"


def test_read_tunnel_url_extracts_latest_url_from_log_output(tmp_path: Path):
    tunnel_file = tmp_path / "cloudflared_url.txt"
    tunnel_file.write_text(
        "\n".join(
            [
                "2026-04-28T10:00:00Z starting tunnel",
                "https://old.trycloudflare.com",
                "2026-04-28T10:00:02Z updated tunnel",
                "https://fresh.trycloudflare.com",
            ]
        ),
        encoding="utf-8",
    )

    assert read_tunnel_url(tunnel_file) == "https://fresh.trycloudflare.com"


def test_read_tunnel_url_returns_none_when_file_missing(tmp_path: Path):
    tunnel_file = tmp_path / "missing.txt"

    assert read_tunnel_url(tunnel_file) is None


def test_build_get_response_returns_url_for_8080():
    assert (
        build_get_response("8080", "https://demo.trycloudflare.com")
        == "https://demo.trycloudflare.com"
    )


def test_build_get_response_returns_unavailable_when_url_missing():
    assert build_get_response("8080", None) == "Chưa có tunnel cho port 8080"


def test_build_get_response_rejects_unsupported_port():
    assert build_get_response("3000", "https://demo.trycloudflare.com") == "Chỉ hỗ trợ port 8080"


def test_get_required_env_reads_environment(monkeypatch):
    monkeypatch.setenv("DISCORD_TOKEN", "abc123")

    assert get_required_env("DISCORD_TOKEN") == "abc123"


def test_get_required_env_raises_when_missing(monkeypatch):
    monkeypatch.delenv("DISCORD_TOKEN", raising=False)

    try:
        get_required_env("DISCORD_TOKEN")
    except RuntimeError as exc:
        assert str(exc) == "Missing required environment variable: DISCORD_TOKEN"
    else:
        raise AssertionError("Expected RuntimeError for missing DISCORD_TOKEN")
