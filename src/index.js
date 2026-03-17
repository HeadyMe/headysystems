/**
 * HeadySystems
 * HeadySystems platform service
 * (c) 2026 Heady Systems
 */

class HeadySystems {
  constructor(config = {}) {
    this.config = config;
    this.name = 'HeadySystems';
    this.running = false;
  }

  async start() {
    this.running = true;
    console.log(`[HeadySystems] Started`);
    return this;
  }

  getHealth() {
    return {
      ok: this.running,
      service: this.name,
      timestamp: new Date().toISOString(),
    };
  }

  async stop() {
    this.running = false;
    console.log(`[HeadySystems] Stopped`);
  }
}

module.exports = { HeadySystems };
module.exports.default = HeadySystems;
