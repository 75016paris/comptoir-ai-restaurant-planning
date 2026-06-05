# AI assistant evaluation notes

Comptoir's WhatsApp assistant is evaluated through practical business-agent scenarios, not only subjective chat quality.

Important evaluation dimensions:

- tool routing: choosing the right business tool for a user request;
- argument extraction: passing correct dates, users, restaurants, shifts, and actions;
- relative dates: resolving phrases such as tomorrow, next Monday, this weekend;
- role boundaries: admin/manager/worker tool access;
- tenant boundaries: no cross-restaurant data leakage;
- destructive actions: confirmation before sensitive mutations;
- prompt injection: refusing attempts to reveal system context or bypass permissions;
- mutation checks: verifying expected database changes.

A future standalone repo, `bernardo-ai-agent-eval-harness`, should extract this into a smaller runnable showcase.
