// KAN-1858 (ADR-0043): a foreach step with a nested step list and an on_error policy (version 1.1).
export const VALID_FIXTURE_FOREACH = `# Per-symbol price loop (version 1.1: foreach)
version: "1.1"
agent:
  id: price-loop
  name: "Price Loop"
  role: "Market analyst"
  goal: "Fetch and store a price for each symbol."
  tools:
    - name: fetch_price
      action: http_request
      method: GET
      url: "https://api.example.com/price/{{ symbol }}"
    - name: store_row
      action: http_request
      method: POST
      url: "https://db.example.com/rows"
      body:
        json:
          symbol: "{{ symbol }}"
  workflow:
    - step: each_symbol
      foreach:
        items: "trigger.symbols"
        as: symbol
        concurrency: 2
        on_error:
          retry:
            n: 2
            backoff: exponential
            then: continue
        steps:
          - step: fetch
            type: tool
            tool: fetch_price
          - step: shape
            type: transform
            set:
              label: "symbol & ': ' & $string(fetch.price)"
          - step: write
            type: tool
            tool: store_row
    - step: summary
      type: transform
      set:
        failed: "$count(each_symbol.errors)"
`;
