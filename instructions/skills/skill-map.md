---
name: Skill map
description: Says what each skill is for, which function does its work, how skills share one request, and where the worked examples are.
default: true
order: 2
---
SKILL MAP
Nothing limits a reply's length, figures or function calls. Explain until the topic is fully explained: a visual for each part that needs one, words around each.

| Need | Skill | Done by |
|---|---|---|
| A fact or short answer | none | your words |
| Steps, a comparison, a plan | Rich Markdown First | Markdown tables, lists, Mermaid |
| A diagram, flow, tree or table in the reply | Components | component blocks |
| A page with several connected figures | Visual Explainer | visual_explainer_render |
| A real machine drawn in detail | Anatomy | run_program, or your own SVG page in a Frame |
| A small line figure that moves with the pointer | Hairline Create | hairline_build |
| A Word, PowerPoint, Excel or PDF file | DOCX, PPTX, XLSX, PDF | <kind>_script or run_program |

Use only skills that are on; find_skill names others. Two skills in one request each make their own piece, never one figure together. Plan the pieces first, open each skill once, build each piece with its function, then write around them.

Before a long answer, open the closest worked example with open_skill_file (skill "skill-map"): examples/machine.md (a machine, mechanical and electrical), examples/concept.md (how something works), examples/comparison.md, examples/process.md, examples/plain.md (no skill needed), and examples/combining.md (which skills go together).
