# DeepSeek dockkit (MIT)

Parts of this directory are ported from the split-tree engine of DeepSeek
dockkit — `packages/client/ui-dockkit/src/contract/types.ts` and
`packages/client/ui-dockkit/src/engine/{tree,operations,planner,constraints,geometry,sequence}.ts`
in https://github.com/deepseek-ai/deepseek-harness (local copy:
`references/deepseek-harness`, commit 46a7f68b0922371ce7144b668b90e377d8e799f4).

Ported files carry an attribution header: `types.ts`, `tree.ts`,
`operations.ts`, `planner.ts`, `geometry.ts` (drop-zone and strip helpers) and
`sequence.ts`. Changes: float panes and the pane budget removed; panes became
groups with per-scope active tabs and bindings; an anchored main node;
`detach`/`attach`/`replaceTree` ops; pixel-minimum resizing; the Branded id
type replaced by plain strings.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
