export const STREAMABLE_TEST_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>MCP StreamableHTTP Test Client</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #f7f9fc; color: #1a1f2b; }
      h1 { margin: 0 0 8px; }
      .row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
      textarea, input, select { width: 100%; padding: 8px; }
      button { padding: 8px 12px; cursor: pointer; }
      pre { background: #0d1321; color: #d9e2f2; padding: 12px; overflow: auto; min-height: 180px; }
      .card { background: #fff; border: 1px solid #d7deeb; border-radius: 10px; padding: 12px; margin: 12px 0; }
    </style>
  </head>
  <body>
    <h1>StreamableHTTP MCP Test</h1>
    <p>Endpoint: <code>/mcp</code></p>

    <div class="card">
      <div class="row"><button id="init">1) Initialize + List Tools</button></div>
      <div class="row">
        <input id="tool" placeholder="Tool name" />
      </div>
      <div class="row">
        <textarea id="args" rows="8">{}</textarea>
      </div>
      <div class="row"><button id="call">2) Call Tool</button></div>
    </div>

    <pre id="out"></pre>

    <script>
      let sessionId = null;
      let requestId = 1;
      const out = document.getElementById('out');
      const tool = document.getElementById('tool');
      const args = document.getElementById('args');

      function log(v) {
        out.textContent += (typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n\n';
      }

      async function rpc(method, params) {
        const payload = { jsonrpc: '2.0', id: requestId++, method, params };
        const headers = { 'content-type': 'application/json' };
        if (sessionId) headers['mcp-session-id'] = sessionId;

        const res = await fetch('/mcp', { method: 'POST', headers, body: JSON.stringify(payload) });
        const sid = res.headers.get('mcp-session-id');
        if (sid) sessionId = sid;
        const body = await res.json();
        if (body.error) throw new Error(JSON.stringify(body.error));
        return body.result;
      }

      document.getElementById('init').onclick = async () => {
        out.textContent = '';
        try {
          const init = await rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'html-test-client', version: '0.1.0' }
          });
          log({ initialize: init, sessionId });

          const list = await rpc('tools/list', {});
          log({ tools: list.tools.map(t => t.name), nextCursor: list.nextCursor || null });
          if (list.tools[0]) tool.value = list.tools[0].name;
        } catch (e) {
          log({ error: String(e) });
        }
      };

      document.getElementById('call').onclick = async () => {
        try {
          const parsedArgs = JSON.parse(args.value || '{}');
          const result = await rpc('tools/call', { name: tool.value, arguments: parsedArgs });
          log(result);
        } catch (e) {
          log({ error: String(e) });
        }
      };
    </script>
  </body>
</html>`;

export const SSE_TEST_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>MCP SSE Test Client</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #f7f9fc; color: #1a1f2b; }
      h1 { margin: 0 0 8px; }
      .row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
      textarea, input { width: 100%; padding: 8px; }
      button { padding: 8px 12px; cursor: pointer; }
      pre { background: #0d1321; color: #d9e2f2; padding: 12px; overflow: auto; min-height: 180px; }
      .card { background: #fff; border: 1px solid #d7deeb; border-radius: 10px; padding: 12px; margin: 12px 0; }
    </style>
  </head>
  <body>
    <h1>SSE MCP Test</h1>
    <p>Connects to <code>/sse</code> and posts to provided <code>/messages</code> endpoint.</p>

    <div class="card">
      <div class="row"><button id="connect">1) Connect + Initialize + List Tools</button></div>
      <div class="row"><input id="tool" placeholder="Tool name" /></div>
      <div class="row"><textarea id="args" rows="8">{}</textarea></div>
      <div class="row"><button id="call">2) Call Tool</button></div>
    </div>

    <pre id="out"></pre>

    <script>
      let endpoint = null;
      let eventSource = null;
      let requestId = 1;
      const pending = new Map();
      const out = document.getElementById('out');
      const tool = document.getElementById('tool');
      const args = document.getElementById('args');

      function log(v) { out.textContent += (typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n\n'; }

      function send(method, params) {
        if (!endpoint) throw new Error('No messages endpoint received yet');
        const id = requestId++;
        const payload = { jsonrpc: '2.0', id, method, params };
        return new Promise(async (resolve, reject) => {
          pending.set(id, { resolve, reject });
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!res.ok) reject(new Error('POST failed: ' + res.status));
        });
      }

      document.getElementById('connect').onclick = async () => {
        out.textContent = '';
        eventSource = new EventSource('/sse');

        eventSource.addEventListener('endpoint', (e) => {
          endpoint = e.data;
          log({ endpoint });
        });

        eventSource.onmessage = async (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
          } else {
            log({ notification: msg });
          }
        };

        eventSource.onerror = (e) => log({ sseError: String(e) });

        const wait = () => new Promise((resolve) => {
          const t = setInterval(() => {
            if (endpoint) { clearInterval(t); resolve(true); }
          }, 100);
        });

        await wait();

        try {
          const init = await send('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'html-sse-client', version: '0.1.0' }
          });
          log({ initialize: init });
          const list = await send('tools/list', {});
          log({ tools: list.tools.map(t => t.name) });
          if (list.tools[0]) tool.value = list.tools[0].name;
        } catch (e) {
          log({ error: String(e) });
        }
      };

      document.getElementById('call').onclick = async () => {
        try {
          const parsedArgs = JSON.parse(args.value || '{}');
          const result = await send('tools/call', { name: tool.value, arguments: parsedArgs });
          log(result);
        } catch (e) {
          log({ error: String(e) });
        }
      };
    </script>
  </body>
</html>`;
