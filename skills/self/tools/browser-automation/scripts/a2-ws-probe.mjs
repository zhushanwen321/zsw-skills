// WS 通路探针：auth + subagent.setModel（假 runId）看错误应答形态
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
const D = process.env.HOME + '/.taiji-dev/instances/feat-workflow-change-model';
const token = readFileSync(D + '/runtime-token', 'utf8').trim();
const port = readFileSync(D + '/runtime.port', 'utf8').trim();
const ws = new WebSocket('ws://localhost:' + port);
const t0 = Date.now();
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token }));
});
ws.on('message', (m) => {
  const d = JSON.parse(m.toString());
  console.log('<<', JSON.stringify(d).slice(0, 300));
  if (d.type === 'auth.result') {
    ws.send(JSON.stringify({ type: 'subagent.setModel', id: 'probe-1', payload: { runId: 'wf-nonexistent-probe', provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' } }));
  }
  if (d.id === 'probe-1') {
    writeFileSync('/tmp/a2-ws-probe-result.json', JSON.stringify(d, null, 2));
    console.log('PROBE REPLY saved');
    ws.close(); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('WS ERR', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 15000);
