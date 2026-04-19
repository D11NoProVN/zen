import os
from pathlib import Path
from typing import Optional

import discord
from discord import app_commands
from dotenv import load_dotenv

load_dotenv(".evn")

GUILD_ID = 1382774908081406092
TUNNEL_URL_FILE = Path(os.getenv("CLOUDFLARED_URL_FILE", "/tmp/cloudflared_url.txt"))


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
        return "Chỉ hỗ trợ port 8080"
    if not tunnel_url:
        return "Chưa có tunnel cho port 8080"
    return tunnel_url


class TunnelBot(discord.Client):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        guild = discord.Object(id=GUILD_ID)

        @self.tree.command(name="get", description="Lấy link tunnel", guild=guild)
        @app_commands.describe(port="Port tunnel cần lấy")
        @app_commands.choices(port=[app_commands.Choice(name="8080", value="8080")])
        async def get_tunnel(
            interaction: discord.Interaction, port: app_commands.Choice[str]
        ) -> None:
            tunnel_url = read_tunnel_url(TUNNEL_URL_FILE)
            message = build_get_response(port.value, tunnel_url)
            await interaction.response.send_message(message)

        await self.tree.sync(guild=guild)


if __name__ == "__main__":
    client = TunnelBot()
    client.run(get_required_env("DISCORD_TOKEN"))
