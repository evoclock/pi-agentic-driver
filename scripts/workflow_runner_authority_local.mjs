import net from 'node:net';
import { relative } from 'node:path';
import { authorityError } from './workflow_runner_authority.mjs';

export function createLocalAuthority(config) {
  function call(op, body) {
    return new Promise(accept => {
      let socket, data = '', finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        socket?.destroy();
        accept(value);
      };
      const unavailable = () => finish(authorityError('AUTHORITY_UNAVAILABLE', true));
      try { socket = net.createConnection(relative(process.cwd(), config.socketPath)); } catch { unavailable(); return; }
      socket.setTimeout(config.timeoutMs ?? 5000, unavailable);
      socket.once('error', unavailable);
      socket.once('end', () => { if (!finished) unavailable(); });
      socket.on('data', chunk => {
        data += chunk;
        if (Buffer.byteLength(data) > 1048576) { unavailable(); return; }
        if (!data.includes('\n')) return;
        try {
          const response = JSON.parse(data.split('\n')[0]);
          if (typeof response.ok !== 'boolean') unavailable();
          else finish(response);
        } catch { unavailable(); }
      });
      socket.once('connect', () => socket.write(`${JSON.stringify({ op, tenantId: config.tenantId, taskId: config.taskId, ...(body ? { body } : {}) })}\n`));
    });
  }
  return {
    commitCancel: body => call('commitCancel', body),
    casAdmitEffect: body => call('casAdmitEffect', body),
    readEpoch: () => call('readEpoch'),
    status: () => call('status'),
  };
}
