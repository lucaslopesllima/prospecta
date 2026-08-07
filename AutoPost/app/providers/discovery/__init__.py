"""Feature futura: busca de temas de inspiração.

Só a interface é definida por ora. Implementações concretas (ex.: RSS,
Google Trends) entram como arquivos novos neste pacote.
"""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Topic:
    titulo: str
    resumo: str
    fonte: str
    url: str | None = None


class TopicSource(Protocol):
    name: str

    async def fetch_topics(self, query: str | None = None, limit: int = 10) -> list[Topic]:
        """Busca temas de inspiração; resultados serão salvos por tenant e
        usáveis como input da IA."""
        ...
