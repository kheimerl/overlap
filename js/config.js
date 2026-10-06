// After deploying apps-script/Code.gs as a web app, paste its URL (ends in /exec) here.
const DEPLOYED_API_URL = 'https://script.google.com/macros/s/AKfycbw4hQV9Y1xT0x34Z0jYtr7vZAqi3tTHp0bHqVbwbkAjEbXabvQ5cnJPRH5MEwHvKn9cOg/exec';

// On localhost, talk to the dev server instead (node dev/server.mjs).
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_URL = LOCAL ? `http://${location.hostname}:8788/` : DEPLOYED_API_URL;

// Must match CONFIG.POW_BITS in Code.gs. Each extra bit doubles event-creation time.
export const POW_BITS = 12;
