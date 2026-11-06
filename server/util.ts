// Shared helpers

export const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
export const logWarn = (m) => console.warn(`[${new Date().toISOString()}] ${m}`);
export const logErr = (m, err) => console.error(`[${new Date().toISOString()}] ${m}`, err);

export const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
