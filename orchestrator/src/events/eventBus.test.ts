import { describe, expect, it } from "vitest";
import { EventBus } from "./eventBus.js";

interface Events {
  PING: { n: number };
  DONE: { ok: boolean };
}

describe("EventBus", () => {
  it("delivers a payload to a subscribed listener", () => {
    const bus = new EventBus<Events>();
    const received: number[] = [];
    bus.on("PING", (p) => received.push(p.n));
    bus.emit("PING", { n: 1 });
    bus.emit("PING", { n: 2 });
    expect(received).toEqual([1, 2]);
  });

  it("supports multiple listeners on the same event", () => {
    const bus = new EventBus<Events>();
    let a = 0;
    let b = 0;
    bus.on("PING", () => a++);
    bus.on("PING", () => b++);
    bus.emit("PING", { n: 1 });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("off() stops delivering to that listener only", () => {
    const bus = new EventBus<Events>();
    let calls = 0;
    const listener = () => calls++;
    bus.on("PING", listener);
    bus.emit("PING", { n: 1 });
    bus.off("PING", listener);
    bus.emit("PING", { n: 2 });
    expect(calls).toBe(1);
  });

  it("on() returns an unsubscribe function", () => {
    const bus = new EventBus<Events>();
    let calls = 0;
    const unsubscribe = bus.on("PING", () => calls++);
    bus.emit("PING", { n: 1 });
    unsubscribe();
    bus.emit("PING", { n: 2 });
    expect(calls).toBe(1);
  });

  it("does not deliver events with no listeners subscribed", () => {
    const bus = new EventBus<Events>();
    expect(() => bus.emit("DONE", { ok: true })).not.toThrow();
  });
});
