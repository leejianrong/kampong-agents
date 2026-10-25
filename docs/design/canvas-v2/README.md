# Canvas v2 mockups

Five boards that show the decisions in [ADR-0059](../../adr/0059-canvas-v2-look-and-feel.md) and
[ADR-0060](../../adr/0060-workflow-assistant-chat-builder.md). They are static mockups of a 1440x900 desktop
window, not code to ship. Open an `.html` file in a browser to see it (fonts load from Google Fonts).

| File | Shows |
| --- | --- |
| `Main.dc.html` | Editing market-etl: cards, loop group, tool pill, floating toolbar, inspector, status bar |
| `Run.dc.html` | After a Replay run: status pills, edge item counts, the bottom run log |
| `Kit.dc.html` | Card anatomy, the twelve step kinds by category, eight states, five edge styles |
| `Chat.dc.html` | The assistant: prompt, plan card, Apply and Undo, new cards marked New |
| `Add.dc.html` | The Add step panel: search, icon tiles, insertion point |

**Where the mockups differ from the decision.** They draw the flow top to bottom. The decision is left to right
(ADR-0059), so read the boards for card design, panels and states, not for layout direction. Connector tiles use
glyphs; the decision is a letter in a brand-like colour. The inspector fields are illustrative.

Reference: n8n, Gumloop and Opus (GovTech) screenshots supplied by the product owner. No third-party
design is copied; the cards, colours and icons are ours.
