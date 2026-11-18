COMPONENT: ProgressBar

A horizontal bar filled to a share of its length. It is as wide as the box it is in.

Written as `<ProgressBar value="60" />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| value | a number | Required. How much of the bar is filled, counted against max. |
| max | a number | The value at which the bar is full. The default is 100. |
| label | text | Shown above the bar. |
| showPercentage | no value | Shows the filled share as a percentage beside the bar. |
| color | primary (the theme's main colour), secondary (its second colour), tertiary (its third colour), success (green), warning (amber), error (red) | The colour of the filled part. |
| size | xs, sm, md, lg, xl, from smallest to largest | The thickness of the bar. |
| striped | no value | Draws diagonal stripes on the filled part. |
| animated | no value | Makes the stripes move. |

```component
<ProgressBar value="3" max="8" label="Steps done" showPercentage color="success" />
```
