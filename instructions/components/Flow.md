COMPONENT: Flow

A diagram of boxes joined by arrows. The boxes are placed automatically from left to right, following the arrows, and the user can move around the diagram and zoom it. It is drawn on screens at least as wide as a tablet.

Written as `<Flow> ... </Flow>` with Node and Edge tags between.

| Attribute | Values | What it does on screen |
|---|---|---|
| height | a CSS length such as 100% or 240px | How tall the diagram is. The default is 380px. |

Tags that go inside Flow:

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Node />` | id, label, color, shape | One box. id (required): a short name of your own, used by Edges. label (required): the text in the box; it may use Markdown such as **bold**, lists and links, with each new line written as &#10;. color: primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red). shape: rectangle (the default), circle, diamond, cylinder. |
| `<Edge />` | source, target, label | One arrow. source and target (both required): the ids of the Node it starts from and the Node it points to. label: text shown on the arrow. |

A Node that no Edge points to starts a new column at the left. Nodes in the same column are stacked.

```component
<Flow>
  <Node id="a" label="**Start**&#10;- gather the brief" color="primary" />
  <Node id="b" label="Check" shape="diamond" />
  <Node id="c" label="Done" color="success" />
  <Edge source="a" target="b" label="then" />
  <Edge source="b" target="c" label="yes" />
</Flow>
```
