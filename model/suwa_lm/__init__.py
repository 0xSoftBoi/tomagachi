"""SUWA-LM — the character adapters the creature trains and sells.

One frozen base model, one small LoRA adapter per character. The fleet is the
product: adapters share a GPU, so the second one is served out of idle capacity
the first already paid for. See research/operating-plan.md.
"""

__version__ = "0.1.0"
