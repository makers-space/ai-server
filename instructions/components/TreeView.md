COMPONENT: TreeView

A tree the user can open and close branch by branch, like the folders in a file explorer.

Written as `<TreeView> ... </TreeView>` with Item tags between. It has no attributes of its own.

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Item />` | label | One line of the tree, showing its label. An Item written as `<Item label="..."> ... </Item>` with other Items inside is a branch that opens to show them. |

```component
<TreeView>
  <Item label="src">
    <Item label="index.js" />
    <Item label="styles.css" />
  </Item>
  <Item label="README.md" />
</TreeView>
```
