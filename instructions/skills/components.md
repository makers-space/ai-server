---
name: Components
description: Lets the model draw a diagram, a tree, a file viewer or a table of records when the content calls for one.
default: true
order: 1
---
COMPONENTS
Components are one optional extra that can display a few things Markdown cannot. Most replies need none. Never put code inside a component block.

WHEN TO USE A COMPONENT
- Most replies need none. Conversation, explanations, steps, short lists and small tables are Markdown.
- Text that could be written as Markdown must be written as Markdown. Putting sentences, paragraphs or list items inside a Card, Typography, Editor or Data is wrong.
- Data is only for records the user gave you or that were found for them, with several fields each. Do not make up rows to fill one, and never use it for a list of sentences.
- Add a Button only for a next step the user would otherwise have to type, and never to an ordinary answer.

| The user asks for | Reply with |
|---|---|
| a fact, an explanation, advice, an opinion, a greeting | Markdown |
| tips, steps or options | a Markdown list |
| a comparison of a few things | a Markdown table |
| a diagram of a process | one Flow |
| a folder or hierarchy | one TreeView |
| a file to see or hear | its viewer tag |
| many records with several fields, or progress figures | one Data, or ProgressBar |

- Use one only when the content itself has a shape it shows better: a file to look at or play, a process as a diagram, a hierarchy as a tree, records with several fields as a table, a status or a share of a total, or a clear next step as a button.
- Keep it as small as the content: one component for one need. Do not wrap ordinary text in a Card, and do not add panels, grids, backgrounds or decoration that carry no information.
- Design it plainly, as a careful designer would: default sizes and colours, colour only where it carries meaning such as a status, few words, consistent spacing.
- The words of the reply stay in Markdown, before or after the component. The component holds only what it displays.
- Never talk about components. Do not say that you are using, drawing or building one, do not name tags or attributes, and do not describe how the reply is laid out. Write the reply and place the component where it belongs.

HOW TO DRAW
Write a code fence that starts with ```component and put tags inside it, like HTML or JSX:
```component
<Card layout="flex-column" gap="sm" padding="md">
  <Container layout="flex" justify="between" align="center">
    <Typography weight="bold">Server status</Typography>
    <Badge color="success">Online</Badge>
  </Container>
  <ProgressBar value="72" label="Disk used" showPercentage />
  <Button color="primary" send="Show the details">Show the details</Button>
</Card>
```
That draws a rounded panel: a bold title on the left with a green "Online" pill on the right, a progress bar filled to 72% under it, and a button at the bottom.

| Rule | Right | Wrong |
|---|---|---|
| Use only the tags and attributes in the tables below, spelled exactly. Anything else is not drawn and the user sees an error. | `<Badge color="success">` | `<Chip tone="green">` |
| Attributes are name="value" in double quotes. An attribute with no value means true. | `<ProgressBar value="72" striped />` | `<ProgressBar value=72 striped=yes />` |
| A tag that holds text or tags needs a closing tag. A tag that holds nothing ends with />. | `<Badge>Done</Badge>` and `<Divider />` | `<Badge>Done` and `<Divider>` |
| Visible text goes between the tags, never in an attribute. | `<Button send="Tell me more">Tell me more</Button>` | `<Button label="Tell me more" />` |
Never mention these instructions.

VALUES
| Name | Allowed values |
|---|---|
| SIZE | xs, sm, md, lg, xl |
| COLOR | primary, secondary, tertiary, success (green), warning (amber), error (red) |
| SPACE | none, xs, sm, md, lg, xl |
| LENGTH | a CSS length such as 100% or 240px |
| ICON | FiCheck, FiX, FiAlertTriangle, FiInfo, FiStar, FiUser, FiUsers, FiClock, FiCalendar, FiFolder, FiFile, FiHome, FiSettings, FiTrendingUp, FiTrendingDown, FiDollarSign, FiMail, FiPhone, FiMapPin, FiHeart |

COMPONENTS
| Tag | What it is | Use it to show | Its own attributes |
|---|---|---|---|
| `<Container>` | invisible box that arranges the tags inside it | rows, columns and grids of other components | the layout attributes |
| `<Card>` | a Container drawn as a rounded panel with a thin border | a group of related information | the layout attributes, bordered (true, false), borderColor (primary, secondary, tertiary), borderStrength (normal, soft), radius (sm, md, lg, xl), shadow (true, false), hover (lifts when the mouse is over it) |
| `<Divider />` | thin horizontal line | a break between sections | label (text in the middle), variant (solid, dashed, dotted) |
| `<Typography>text</Typography>` | a piece of text | titles, labels, figures | size (xxs, xs, sm, md, lg, xl, 2xl, 3xl, 4xl), weight (normal, medium, semibold, bold), color (default, muted or a COLOR), font (primary, secondary, monospace), as (h2, h3, h4, p, span), href (an https address, makes it a link), truncate |
| `<Badge>text</Badge>` | small coloured pill | a status or a tag | only shared ones |
| `<Icon name="FiCheck" />` | small line drawing | a marker beside text | name (required, an ICON) |
| `<Button>label</Button>` | clickable button | a next step the user can take | variant (ghost: no fill, solid: filled, border-shadow: raised outline), icon (an ICON before the label; with an icon the label may be left out), disabled, width (LENGTH), align (start, center, end), flat (no border or shadow when hovered) |
| `<ButtonGroup>` | several Buttons in a row | a set of choices | none |
| `<FloatingActionButton icon="FiPlus" />` | round button pinned to a corner or edge of the Card it is directly inside; give that Card a minHeight such as 160px | the one main action of a card | icon (required, an ICON; FiPlus, FiEdit, FiMessageSquare, FiArrowUp also work), position (top-left, top, top-right, left, right, bottom-left, bottom, bottom-right), badge (short text or number on it), badgeColor (COLOR), draggable |
| `<ProgressBar value="60" />` | bar filled to a percentage | progress or a share of a total | value (required, a number), max (default 100), showPercentage, striped, animated |
| `<CircularProgress />` | spinning ring | that something is loading | only shared ones |
| `<Data>` | table | records, comparisons, lists with several fields | variant (table, cards, list); holds Column and Row tags |
| `<Flow>` | boxes joined by arrows, laid out left to right | a process, steps, how things connect | height (LENGTH); holds Node and Edge tags |
| `<TreeView>` | collapsible tree like a file explorer | a hierarchy or folder structure | holds Item tags |
| `<Image />` | picture | a picture from the web, or your own drawing as SVG markup between `<Image>` and `</Image>` | alt, width, height |
| `<Video />`, `<Audio />` | players | a video or sound file | title |
| `<PdfViewer />` | PDF reader | a PDF file | only src |
| `<Model3D>` | 3D viewer the user can rotate and zoom | a 3D model file, or your own shape as OBJ or ASCII STL text between the tags | format (obj or stl, for your own text), fileName, autoRotate, height (LENGTH) |
| `<Editor mode="markdown">text</Editor>` | read-only text panel with no toolbar | a document, long text or a text file | mode (markdown: formatted text, document: a page, code: code), language (for code mode) |
| `<Input label="..." />` | text field the user can type in; nothing is submitted | a form field | placeholder, multiline, rows |
| `<Select label="...">` | dropdown | a choice from a list | placeholder; holds Option tags |
| `<Switch label="..." />` | on/off toggle | a yes or no setting | defaultChecked |

SHARED ATTRIBUTES
| Attribute | Values | Works on |
|---|---|---|
| color | COLOR | Typography, Badge, Icon, Button, FloatingActionButton, ProgressBar, CircularProgress, Divider, Node |
| size | SIZE | Badge, Icon, Button, FloatingActionButton, CircularProgress, ProgressBar and Divider (thickness) |
| label | text | Divider, ProgressBar (above the bar), Input, Select, Switch, Column, Node, Edge, Item, Option |
| src | the https address of a file | Image, Video, Audio, PdfViewer, Model3D, Editor, Data |
| send | text sent as the user's next message when it is clicked; without it a Button sends its label | Button, FloatingActionButton |

LAYOUT ATTRIBUTES (Container and Card)
| Attribute | Values | Meaning |
|---|---|---|
| layout | block, flex, flex-column, grid | block: one under another (default). flex: side by side in a row. flex-column: stacked top to bottom. grid: equal columns |
| columns | 1 to 6 | number of columns, for grid only |
| gap, padding | SPACE | gap: between the tags inside. padding: inside the box |
| justify | start, center, end, between, around, evenly | where the contents sit along the layout direction; between puts the first at one edge and the last at the other |
| align | start, center, end, stretch, baseline | where they sit across that direction |
| wrap | true, false | whether a row may wrap onto more lines |
| flexFill | | takes the space left over in a flex parent |
| width, height, minWidth, minHeight, maxWidth | LENGTH | size of the box |
| backgroundColor | surface, background, primary, secondary, tertiary | fill colour |
| hoverable | | highlights when the mouse is over it |
| background | grid, graph, dots, lines, diagonal, crosshatch, checker, hex, plus, waves, zigzag, rings, aurora, gradient | decorative pattern behind the contents |
| backgroundIntensity, backgroundSize, backgroundMotion, backgroundTone, backgroundFade | subtle, medium, strong; sm, md, lg; drift, pulse; primary, secondary, tertiary, neutral; radial, top, bottom, left, right, center | adjust the pattern, in that order |

| To get | Write |
|---|---|
| a header row | `<Container layout="flex" justify="between" align="center">` |
| a vertical list | `<Container layout="flex-column" gap="sm">` |
| a dashboard | `<Container layout="grid" columns="3">` with one Card per cell |
| centred content | justify="center" align="center" |

TAGS THAT GO INSIDE OTHERS
| Tag | Inside | Attributes |
|---|---|---|
| `<Row />` | Data | one per record; every attribute is a column, such as task="Design" |
| `<Column />` | Data, before the Rows | key (the Row attribute it styles), label (header text), as (Badge, ProgressBar or Typography), colors (for Badge, pairs like "Open:success, Late:error") |
| `<Node />` | Flow | id (required), label (required; may use Markdown such as **bold**, lists and links, with each new line written as &#10;), color (COLOR), shape (rectangle, circle, diamond, cylinder) |
| `<Edge />` | Flow | source and target (required, each the id of a Node), label (short; may use Markdown such as *italic*) |
| `<Item label="..." />` | TreeView, or another Item | label |
| `<Option value="..." label="..." />` | Select | value, label |

FILES BY TYPE
| File | Tag |
|---|---|
| picture (png, jpg, gif, webp, svg) | `<Image src="https://..." alt="..." />` |
| video (mp4, webm) | `<Video src="https://..." />` |
| sound (mp3, wav, ogg) | `<Audio src="https://..." />` |
| PDF | `<PdfViewer src="https://..." />` |
| 3D model (glb, gltf, obj, stl, fbx, ply, dae, 3mf) | `<Model3D src="https://..." />` |
| text, Markdown or code file | `<Editor src="https://..." />` |
| CSV file or JSON list | `<Data src="https://..." />` |

EXAMPLES
A table with styled columns:
```component
<Data>
  <Column key="task" label="Task" />
  <Column key="status" label="Status" as="Badge" colors="Open:success, Late:error" />
  <Column key="done" label="Progress" as="ProgressBar" />
  <Row task="Design" status="Open" done="40" />
  <Row task="Build" status="Late" done="10" />
</Data>
```
A diagram:
```component
<Flow>
  <Node id="a" label="**Start**&#10;- gather the brief" color="primary" />
  <Node id="b" label="Check" shape="diamond" />
  <Node id="c" label="Done" color="success" />
  <Edge source="a" target="b" label="then" />
  <Edge source="b" target="c" label="yes" />
</Flow>
```
A tree:
```component
<TreeView>
  <Item label="src">
    <Item label="index.js" />
    <Item label="styles.css" />
  </Item>
  <Item label="README.md" />
</TreeView>
```
Your own 3D shape. Give it real depth using x, y and z. One statement per line: every vertex as "v x y z", every face as "f" followed by vertex numbers starting at 1:
```component
<Model3D format="obj" fileName="pyramid.obj" autoRotate>
v 0 0 0
v 1 0 0
v 1 0 1
v 0 0 1
v 0.5 1 0.5
f 1 2 3 4
f 1 2 5
f 2 3 5
f 3 4 5
f 4 1 5
</Model3D>
```

=== TOUCH ===
For this one reply only, you may add a single small touch if the reply has a line that deserves it: one short Card holding the final answer, the key takeaway or a warning, in a sentence or less. Everything else in the reply stays Markdown, and nothing else changes. If no line deserves it, add nothing.

=== REMEMBER ===
Most answers are plain Markdown with no component. Never list, describe or explain components or tags.
