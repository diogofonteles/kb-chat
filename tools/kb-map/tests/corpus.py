"""The fixture corpus: three principles across two authors, plus one off-topic source."""

from pathlib import Path

from conftest import TOPIC, write_concept, write_doc
from fakes import Model
from kb_map.extract import extract_document
from kb_map.layout import MapLayout, ReviewQueue
from kb_map.providers import Ledger
from kb_map.tree import TreeBuilder
from kb_map.vault import Topic, Vault

ML = {"author": "José Laércio do Egito", "author_group": "mestre-laercio"}
OTHER = {"author": "Três Iniciados", "author_group": "outros-autores"}

RITMO = """# Ritmo I

A lei do ritmo rege tudo. O Caibalion chama de fluxo e refluxo.

# Ritmo II

O pêndulo do ritmo oscila entre os polos. Ele se compensa.

# Ritmo III

O ritmo pode ser neutralizado pelo iniciado. Mestre Laércio insiste nisso.
"""

POLARIDADE = """# Polaridade I

Tudo é duplo; a polaridade une os opostos. O Caibalion ensina isso.

# Polaridade II

Os opostos são o mesmo em graus diferentes de polaridade.

# Polaridade III

A polaridade mental se transmuta. Hermes Trismegisto ensinou.
"""

VIBRACAO = """# Vibração I

Nada está parado; tudo vibra. A vibração distingue os planos.

# Vibração II

A vibração do espírito é a mais alta. O Caibalion explica.

# Vibração III

Quem domina a vibração domina a matéria.
"""

RECEITA = """# Torta de pêssego

Misture a farinha, o açúcar e os pêssegos. Asse por quarenta minutos.
"""


def build_corpus(vault: Path, with_recipe: bool = True) -> Topic:
    write_concept(vault, "Sete Princípios", "Os sete princípios herméticos.", ("Seven Principles",))
    write_concept(vault, "Cabala", "A Cabala e a Árvore da Vida.", ("Kabbalah",))
    write_doc(vault, "raw/articles/ritmo-ml.md", RITMO, title="Aula sobre o ritmo", **ML)
    write_doc(vault, "raw/articles/polaridade.md", POLARIDADE, title="O Caibalion", **OTHER)
    write_doc(vault, "raw/articles/vibracao-ml.md", VIBRACAO, title="Aula sobre a vibração", **ML)
    if with_recipe:
        write_doc(vault, "raw/articles/receita.md", RECEITA, title="Receita", **OTHER)
    return Vault(vault).topic(TOPIC)


def extract_all(topic: Topic, model: Model) -> None:
    queue = ReviewQueue(MapLayout(topic))
    ledger = Ledger(model.provider())
    for doc in topic.documents():
        extract_document(topic, ledger, queue, doc)
    queue.save()


def build_tree(topic: Topic, model: Model, **sizes):
    queue = ReviewQueue(MapLayout(topic))
    provider = model.provider()
    report = TreeBuilder(topic, Ledger(provider), queue, **sizes).build()
    queue.save()
    return report, provider
