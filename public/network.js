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
    this.lastSnapshot = null;

    this.bindSocketEvents();
  }

  bindSocketEvents() {
    this.socket.on("connect", () => {
      this.connected = true;
      this.playerId = this.socket.id;

      this.emit("connected", {
        playerId: this.playerId
      });
    });

    this.socket.on("disconnect", reason => {
      this.connected = false;
      this.room = null;
      this.role = null;
      this.lastSnapshot = null;
    
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

    this.socket.on("net:input", payload => {
      this.emit("remote-input", payload);
    });

    this.socket.on("net:snapshot", snapshot => {
      this.lastSnapshot = snapshot;
      this.emit("snapshot", snapshot);
    });

    this.socket.on(
      "net:upgrade-offers",
      payload => {
        this.emit(
          "upgrade-offers",
          payload
        );
      }
    );

    this.socket.on(
      "net:upgrade-choice",
      payload => {
        this.emit(
          "upgrade-choice",
          payload
        );
      }
    );

    this.socket.on("net:game-event", payload => {
      this.emit("game-event", payload);
    });
  }

  emit(type, detail) {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail
      })
    );
  }

  request(eventName, payload = {}) {
    return new Promise(resolve => {
      this.socket.emit(
        eventName,
        payload,
        result => {
          resolve(
            result || {
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
    }

    return result;
  }

  async joinRoom(code, name) {
    const result = await this.request(
      "room:join",
      {
        code,
        name
      }
    );

    if (result.success) {
      this.role = "guest";
      this.room = result.room;
      this.playerId = result.playerId;
    }

    return result;
  }

  async leaveRoom() {
    const result = await this.request(
      "room:leave"
    );

    if (result.success) {
      this.room = null;
      this.role = null;
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

  async sendReady(ready) {
    return this.request("room:ready", { ready: Boolean(ready) });
  }

  async setDifficulty(difficulty) {
    return this.request("room:set-difficulty", { difficulty });
  }

  sendInput(input) {
    if (!this.isMultiplayer) {
      return;
    }
  
    this.socket.emit(
      "net:input",
      input
    );
  }

  requestSnapshot() {
    if (!this.isMultiplayer) {
      return;
    }
  
    this.socket.emit(
      "net:request-snapshot"
    );
  }

  sendTogglePause() {
    if (!this.isMultiplayer) {
      return;
    }
    this.socket.emit("net:toggle-pause");
  }

  sendShoot(aimX, aimY) {
    if (!this.isMultiplayer) {
      return;
    }
  
    this.socket.emit("net:shoot", {
      aimX,
      aimY
    });
  }

  sendUpgradeChoice(offerId, index) {
    this.socket.emit(
      "net:upgrade-choice",
      {
        offerId,
        index
      }
    );
  }

  sendReroll(offerId) {
    return this.request("net:reroll-offers", { offerId });
  }

  sendUpgradeOffers(
    targetId,
    offerId,
    playerLevel,
    pendingLevelUps,
    offers
  ) {
    if (this.role !== "host") {
      return;
    }

    this.socket.emit(
      "net:upgrade-offers",
      {
        targetId,
        offerId,
        playerLevel,
        pendingLevelUps,
        offers
      }
    );
  }

  sendGameEvent(payload) {
    if (this.role !== "host") {
      return;
    }

    this.socket.emit(
      "net:game-event",
      payload
    );
  }

  get isHost() {
    return this.role === "host";
  }

  get isGuest() {
    return this.role === "guest";
  }

  get isMultiplayer() {
    return Boolean(
      this.room && this.role
    );
  }
}

window.net = new OneBulletNetwork();
