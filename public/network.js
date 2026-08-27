"use strict";

class OneBulletNetwork extends EventTarget {
  constructor() {
    super();

    this.socket = io({
      transports: ["websocket", "polling"],
      upgrade: true,
      rememberUpgrade: true
    });

    this.connected = false;
    this.room = null;
    this.role = null;
    this.playerId = null;
    this.reconnectToken = null;
    this.lastSnapshot = null;

    this.pingMs = 0;
    this.jitterMs = 0;
    this.snapshotRate = 20;
    this.snapshotIntervals = [];
    this.lastSnapshotAt = 0;
    this.pingTimer = null;

    this.bindSocketEvents();
  }

  saveReconnectData(roomCode, token, playerName) {
    try {
      const expiresAt = Date.now() + 120000;
      const data = JSON.stringify({ roomCode, token, playerName, expiresAt, timestamp: Date.now() });
      sessionStorage.setItem("one_bullet_reconnect_v1", data);
      localStorage.setItem("one_bullet_reconnect_v1", data);
    } catch {}
  }

  getReconnectData() {
    try {
      const raw = sessionStorage.getItem("one_bullet_reconnect_v1") || localStorage.getItem("one_bullet_reconnect_v1");
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.roomCode || !data.token) return null;
      if (data.expiresAt && data.expiresAt < Date.now()) {
        this.clearReconnectData();
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  clearReconnectData() {
    try {
      sessionStorage.removeItem("one_bullet_reconnect_v1");
      localStorage.removeItem("one_bullet_reconnect_v1");
    } catch {}
  }

  bindSocketEvents() {
    this.socket.on("connect", () => {
      this.connected = true;
      this.playerId = this.socket.id;
      this.startPingLoop();

      this.emit("connected", {
        playerId: this.playerId
      });
    });

    this.socket.on("disconnect", reason => {
      this.connected = false;
      this.room = null;
      this.role = null;
      this.lastSnapshot = null;
      this.stopPingLoop();
    
      this.emit("disconnected", {
        reason
      });
    });

    this.socket.on("room:state", room => {
      this.room = room;
      this.emit("room-state", room);
    });

    this.socket.on("room:started", payload => {
      this.emit("room-started", payload);
    });

    this.socket.on("room:closed", payload => {
      this.room = null;
      this.role = null;
      this.clearReconnectData();

      this.emit("room-closed", payload);
    });

    this.socket.on("room:peer-joined", payload => {
      this.emit("peer-joined", payload);
    });

    this.socket.on("room:peer-left", payload => {
      this.emit("peer-left", payload);
    });

    this.socket.on("room:returned-to-lobby", payload => {
      if (payload?.room) {
        this.room = payload.room;
      }
      this.emit("returned-to-lobby", payload);
    });

    this.socket.on("net:remote-input", payload => {
      this.emit("remote-input", payload);
    });

    this.socket.on("net:snapshot", snapshot => {
      this.lastSnapshot = snapshot;

      const now = performance.now();
      if (this.lastSnapshotAt > 0) {
        const dtMs = now - this.lastSnapshotAt;
        this.snapshotIntervals.push(dtMs);
        if (this.snapshotIntervals.length > 20) this.snapshotIntervals.shift();
        const avgDt = this.snapshotIntervals.reduce((a, b) => a + b, 0) / this.snapshotIntervals.length;
        this.snapshotRate = avgDt > 0 ? Math.round(1000 / avgDt) : 20;
        const variance = this.snapshotIntervals.reduce((sum, val) => sum + Math.pow(val - avgDt, 2), 0) / this.snapshotIntervals.length;
        this.jitterMs = Math.round(Math.sqrt(variance));
      }
      this.lastSnapshotAt = now;

      this.emit("snapshot", snapshot);
    });

    const handleUpgradeOffers = (payload) => this.emit("upgrade-offers", payload);
    this.socket.on("net:upgrade-offers", handleUpgradeOffers);
    this.socket.on("coop:upgrade-offers", handleUpgradeOffers);

    const handleUpgradeApplied = (payload) => this.emit("upgrade-applied", payload);
    this.socket.on("net:upgrade-applied", handleUpgradeApplied);
    this.socket.on("coop:upgrade-applied", handleUpgradeApplied);

    const handleGameEvent = (payload) => this.emit("game-event", payload);
    this.socket.on("net:game-event", handleGameEvent);
    this.socket.on("coop:game-event", handleGameEvent);
  }

  startPingLoop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;
      const t0 = performance.now();
      this.socket.emit("net:ping", t0, (res) => {
        if (res && res.timestamp) {
          const rtt = Math.round(performance.now() - t0);
          this.pingMs = this.pingMs > 0 ? Math.round(this.pingMs * 0.7 + rtt * 0.3) : rtt;
        }
      });
    }, 2000);
  }

  stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  on(type, listener) {
    this.addEventListener(type, (event) => listener(event.detail));
  }

  emit(type, detail) {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail
      })
    );
  }

  get isHost() {
    return this.role === "host";
  }

  get isMultiplayer() {
    return Boolean(
      this.room &&
      this.role
    );
  }

  request(eventName, payload = {}, timeoutMs = 6000) {
    return new Promise((resolve) => {
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({
            success: false,
            message: "Превышено время ожидания ответа сервера"
          });
        }
      }, timeoutMs);

      this.socket.emit(
        eventName,
        payload,
        response => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          resolve(
            response || {
              success: false,
              message: "Сервер не ответил"
            }
          );
        }
      );
    });
  }

  async createRoom(name) {
    const result = await this.request(
      "room:create",
      { name }
    );

    if (result.success) {
      this.role = "host";
      this.room = result.room;
      this.playerId = result.playerId;
      this.reconnectToken = result.reconnectToken;
      if (result.reconnectToken && result.room?.code) {
        this.saveReconnectData(result.room.code, result.reconnectToken, name);
      }
    }

    return result;
  }

  async joinRoom(code, name, bulletSkin = "neon") {
    const saved = this.getReconnectData();
    const token = (saved && saved.roomCode === code) ? saved.token : null;

    const result = await this.request(
      "room:join",
      {
        code,
        name,
        bulletSkin,
        token
      }
    );

    if (result.success) {
      this.role = result.role || "guest";
      this.room = result.room;
      this.playerId = result.playerId;
      this.reconnectToken = result.reconnectToken || token;
      if (result.snapshot) {
        this.lastSnapshot = result.snapshot;
      }
      if (this.reconnectToken && code) {
        this.saveReconnectData(code, this.reconnectToken, name);
      }
    }

    return result;
  }

  async reconnectRoom(code, token, name) {
    const result = await this.request(
      "room:reconnect",
      {
        code,
        token,
        name
      }
    );

    if (result.success) {
      this.role = result.role;
      this.room = result.room;
      this.playerId = result.playerId;
      this.reconnectToken = result.reconnectToken || token;
      if (result.snapshot) {
        this.lastSnapshot = result.snapshot;
      }
      this.saveReconnectData(code, this.reconnectToken, name);
    }

    return result;
  }

  async cancelReconnectWait() {
    return this.request("room:cancel-reconnect-wait");
  }

  async leaveRoom() {
    const result = await this.request(
      "room:leave"
    );

    if (result.success) {
      this.room = null;
      this.role = null;
      this.clearReconnectData();
    }

    return result;
  }

  async startRoom(difficulty) {
    return this.request(
      "room:start",
      {
        difficulty
      }
    );
  }

  async restartRoom() {
    return this.request("room:restart");
  }

  async returnToLobby() {
    return this.request("room:return-to-lobby");
  }

  async sendReady(ready, bulletSkin = "neon") {
    return this.request("room:ready", { ready: Boolean(ready), bulletSkin });
  }

  sendSkin(bulletSkin) {
    if (!this.isMultiplayer || this.socket?.connected === false) return;
    try {
      this.socket.emit("net:set-skin", { bulletSkin });
    } catch {}
  }

  async setDifficulty(difficulty) {
    return this.request("room:set-difficulty", { difficulty });
  }

  sendInput(input) {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }
  
    try {
      this.socket.volatile.emit(
        "net:input",
        input
      );
    } catch {}
  }

  requestSnapshot() {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }
  
    try {
      this.socket.emit(
        "net:request-snapshot"
      );
    } catch {}
  }

  sendTogglePause() {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }
    try {
      this.socket.emit("net:toggle-pause");
    } catch {}
  }

  sendNetDebugCommand(action, data = {}) {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }
    try {
      this.socket.emit("net:debug-command", { action, data });
    } catch {}
  }

  sendShoot(x, y, vx, vy) {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }

    try {
      this.socket.emit("net:shoot", {
        aimX: x,
        aimY: y,
        clientShootX: vx,
        clientShootY: vy,
        x: vx,
        y: vy,
        vx,
        vy
      });
    } catch {}
  }

  sendCatchBullet(bulletId, x, y) {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }

    try {
      this.socket.emit(
        "net:catch-bullet",
        {
          bulletId,
          x,
          y
        }
      );
    } catch {}
  }

  sendUpgradeChoice(offerId, index) {
    if (!this.isMultiplayer || this.socket?.connected === false) {
      return;
    }

    try {
      this.socket.emit(
        "net:upgrade-choice",
        {
          offerId,
          index
        }
      );
    } catch {}
  }

  sendReroll(offerId) {
    if (!this.isMultiplayer) {
      return Promise.resolve({ success: false });
    }

    return this.request(
      "net:reroll-offers",
      {
        offerId
      }
    );
  }

  selectUpgrade(offerId, index) {
    return this.sendUpgradeChoice(offerId, index);
  }

  rerollUpgrades(offerId) {
    return this.sendReroll(offerId);
  }
}

window.net = new OneBulletNetwork();
