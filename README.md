# Agent skills

These agents and skills use LLM assistance. I use them in [omp](https://omp.sh).

## Installation

Store them in a `.agents` folder. Copy the ones your project needs.

## Rationale

I use different vendors and models. These skills and agents should work without vendor-specific tooling, then improve when other tooling is available.

```math
verbosity = \frac{|\text{AST-Grep flagged lines} \cup \text{clone lines}|}{\text{LOC}}
```

```math
mass(f) = CC(f) \sqrt{\text{SLOC}(f)}
```

```math
erosion = \frac{\sum_{f:CC(f)>10}mass(f)}{\sum_f mass(f)}
```