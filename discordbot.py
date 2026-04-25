import os
from pathlib import Path
from typing import Optional

import discord
from discord import app_commands
from dotenv import load_dotenv

load_dotenv(".evn")

GUILD_ID = 1382774908081406092
TUNNEL_URL_FILE = Path(os.getenv("CLOUDFLARED_URL_FILE", "/tmp/cloudflared_url.txt"))
PROXY_INFO_FILE = Path("/tmp/proxy_info.txt")


def get_required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def read_tunnel_url(path: str | Path) -> Optional[str]:
    file_path = Path(path)
    if not file_path.exists():
        return None

    value = file_path.read_text(encoding="utf-8").strip()
    return value or None


def build_get_response(port: str, tunnel_url: Optional[str]) -> str:
    if port != "8080":
        return f"Chua co thong tin cho port {port}"
    if not tunnel_url:
        return f"Chua co tunnel cho port {port}"
    return f"**Web UI:** {tunnel_url}"


class TunnelBot(discord.Client):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        guild = discord.Object(id=GUILD_ID)

        @self.tree.command(name="get", description="Lay link tunnel", guild=guild)
        @app_commands.describe(port="Port tunnel can lay")
        @app_commands.choices(port=[
            app_commands.Choice(name="8080 (Web UI)", value="8080"),
            app_commands.Choice(name="8081 (Proxy)", value="8081")
        ])
        async def get_tunnel(
            interaction: discord.Interaction, port: app_commands.Choice[str]
        ) -> None:
            if port.value == "8080":
                tunnel_url = read_tunnel_url(TUNNEL_URL_FILE)
                message = build_get_response(port.value, tunnel_url)
            else:
                if not PROXY_INFO_FILE.exists():
                    message = "Chua co thong tin Proxy 8081. Doi ty may!"
                else:
                    info = PROXY_INFO_FILE.read_text().strip()
                    host, p = info.split(":")
                    message = (
                        "**Proxy cua may day:**\n"
                        f"HTTP: `http://zen:123456@{host}:{p}`\n"
                        f"SOCKS5: `socks5://zen:123456@{host}:{p}`\n"
                        f"Host: `{host}` | Port: `{p}` | User: `zen` | Pass: `123456`"
                    )

            await interaction.response.send_message(message)

        await self.tree.sync(guild=guild)


if __name__ == "__main__":
    client = TunnelBot()
    client.run(get_required_env("DISCORD_TOKEN"))
