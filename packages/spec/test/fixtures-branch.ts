// KAN-1859 (ADR-0045): a branch step (if/else and switch) with nested step lists, and an early stop (version 1.1).
export const VALID_FIXTURE_BRANCH = `# Triage (version 1.1: branch, switch and stop)
version: "1.1"
agent:
  id: triage
  name: "Triage"
  role: "Support triager"
  goal: "Answer confident tickets, escalate the rest, and ignore duplicates."
  tools:
    - name: reply
      action: http_request
      method: POST
      url: "https://support.example.com/reply"
    - name: escalate
      action: http_request
      method: POST
      url: "https://support.example.com/escalate"
  workflow:
    - step: classify
      action: classify_ticket
      confidence_gate: false
    - step: route
      branch:
        switch: "classify.text"
        cases:
          duplicate:
            - step: ignore
              stop:
                reason: "duplicate ticket {{ trigger.id }}"
          urgent:
            - step: page
              type: tool
              tool: escalate
            - step: ask
              type: approval
              message: "Escalated {{ trigger.id }}"
        default:
          - step: confident
            branch:
              if: "$length(classify.text) > 3"
              then:
                - step: answer
                  type: tool
                  tool: reply
              else:
                - step: hold
                  stop:
                    status: completed
                    reason: "nothing to answer"
    - step: summary
      type: transform
      set:
        routed: "route.taken"
`;

// Branches and loops nested both ways: a foreach inside a branch arm, a branch inside a foreach body, and a
// stop in the body that ends only that item.
export const VALID_FIXTURE_BRANCH_IN_LOOP = `# Nested branch and foreach (version 1.1)
version: "1.1"
agent:
  id: nested-branch
  name: "Nested"
  role: "Analyst"
  goal: "Process only what is worth processing."
  tools:
    - name: store_row
      action: http_request
      method: POST
      url: "https://db.example.com/rows"
      body:
        json:
          id: "{{ row.id }}"
  workflow:
    - step: gate
      branch:
        if: "$count(trigger.rows) = 0"
        then:
          - step: nothing
            stop:
              reason: "no rows"
        else:
          - step: each_row
            foreach:
              items: "trigger.rows"
              as: row
              on_error: continue
              steps:
                - step: check
                  branch:
                    if: "row.ignore = true"
                    then:
                      - step: skip_row
                        stop:
                          reason: "row {{ row.id }} ignored"
                    else:
                      - step: write
                        type: tool
                        tool: store_row
    - step: summary
      type: transform
      set:
        wrote: "$count(each_row.results)"
`;
