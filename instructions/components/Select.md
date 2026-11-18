COMPONENT: Select

A dropdown: a field that opens a list to pick one entry from. The pick stays in the field: it is not sent anywhere.

Written as `<Select label="..."> ... </Select>` with Option tags between.

| Attribute | Values | What it does on screen |
|---|---|---|
| label | text | Shown above the field. |
| placeholder | text | Greyed text inside the field before anything is picked. |

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Option />` | value, label | One entry in the list. label is the text shown. value is a short name for it. |

```component
<Select label="Size" placeholder="Pick one">
  <Option value="s" label="Small" />
  <Option value="l" label="Large" />
</Select>
```
