const ENGINE_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-18-lite-single.js`;

function parseInfo(line) {
  if (!line.startsWith('info ')) return null;
  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const multipvMatch = line.match(/\bmultipv\s+(\d+)/);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
  const pvMatch = line.match(/\bpv\s+([^\s]+)/);
  if (!cpMatch && !mateMatch) return null;
  return {
    depth: depthMatch ? Number(depthMatch[1]) : 0,
    multipv: multipvMatch ? Number(multipvMatch[1]) : 1,
    cp: cpMatch ? Number(cpMatch[1]) : null,
    mate: mateMatch ? Number(mateMatch[1]) : null,
    pvMove: pvMatch ? pvMatch[1] : null,
  };
}

export class StockfishClient {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.current = null;
    this.multiPv = 1;
  }

  async init() {
    if (this.ready) return;
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (event) => this.#onMessage(String(event.data ?? ''));
    this.worker.onerror = (event) => {
      if (this.current) {
        this.current.reject(new Error(event.message || 'Stockfish worker failed.'));
        this.current = null;
      }
    };

    await this.#waitFor('uciok', () => this.worker.postMessage('uci'));
    this.worker.postMessage('setoption name Hash value 64');
    await this.#waitFor('readyok', () => this.worker.postMessage('isready'));
    this.ready = true;
  }

  #waitFor(token, send) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Stockfish did not answer ${token}.`)), 15000);
      const previous = this.current;
      this.current = {
        mode: 'token',
        token,
        resolve: () => {
          clearTimeout(timeout);
          this.current = previous;
          resolve();
        },
        reject: (e) => {
          clearTimeout(timeout);
          this.current = previous;
          reject(e);
        },
      };
      send();
    });
  }

  #onMessage(line) {
    const current = this.current;
    if (!current) return;

    if (current.mode === 'token') {
      if (line.includes(current.token)) current.resolve();
      return;
    }

    if (current.mode === 'analysis') {
      const info = parseInfo(line);
      if (info) {
        const previous = current.lines.get(info.multipv);
        if (!previous || info.depth >= previous.depth) current.lines.set(info.multipv, info);
      }
      if (line.startsWith('bestmove')) {
        const lines = [...current.lines.values()].sort((a, b) => a.multipv - b.multipv);
        const best = lines[0] || { depth: 0, cp: 0, mate: null, multipv: 1, pvMove: null };
        this.current = null;
        current.resolve({ ...best, lines });
      }
    }
  }

  async evaluate(fen, nodes = 12000, multiPv = 1) {
    await this.init();
    if (this.current) throw new Error('Stockfish is already searching.');

    const requestedMultiPv = Math.max(1, Math.min(4, Math.round(Number(multiPv) || 1)));
    if (requestedMultiPv !== this.multiPv) {
      this.worker.postMessage(`setoption name MultiPV value ${requestedMultiPv}`);
      this.multiPv = requestedMultiPv;
    }

    return new Promise((resolve, reject) => {
      this.current = { mode: 'analysis', lines: new Map(), resolve, reject };
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go nodes ${Math.max(500, Math.round(nodes))}`);
    });
  }

  stop() {
    try { this.worker?.postMessage('stop'); } catch {}
  }

  terminate() {
    try { this.worker?.terminate(); } catch {}
    this.worker = null;
    this.ready = false;
    this.current = null;
    this.multiPv = 1;
  }
}
