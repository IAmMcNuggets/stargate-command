'use strict';
/*
 * Remote destinations: validating a host, and finding something to connect
 * with.
 *
 * Passing argv arrays already rules out shell injection. It does not rule out
 * ARGUMENT injection: mstsc and the FreeRDP clients read a leading "-" or "/"
 * as an option, so an unchecked host could quietly turn into a flag. Only a
 * hostname, an IPv4 address, or a bracketed IPv6 address gets through here,
 * with an optional port and nothing else.
 *
 * Credentials are deliberately not handled. Every RDP client prompts and the
 * OS keeps what it is given; putting a password in settings.json would be a
 * real problem and buys nothing.
 */

const HOSTNAME =
  /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_BRACKETED = /^\[[0-9A-Fa-f:.]{2,45}\]$/;

/**
 * @param {string} raw  what the user typed
 * @returns {{host:string, port:string, spec:string}}
 * @throws  when it is anything other than a host we are willing to hand to an
 *          RDP client
 */
function parseHost(raw) {
  const t = String(raw || '').trim();
  if (!t) throw new Error('a host is required');
  if (t.length > 300) throw new Error('that host is too long');

  let host = t;
  let port = '';

  const v6 = t.match(/^(\[[^\]]*\])(?::(\d{1,5}))?$/);
  if (v6) {
    host = v6[1];
    port = v6[2] || '';
    if (!IPV6_BRACKETED.test(host)) throw new Error('that is not a valid IPv6 address');
  } else {
    // A bare colon separates host from port. IPv6 without brackets is
    // ambiguous with that, so it is rejected rather than guessed at.
    const at = t.lastIndexOf(':');
    if (at > 0) {
      host = t.slice(0, at);
      port = t.slice(at + 1);
      if (!port) throw new Error('that is not a valid port');
    }
    // All-numeric labels are legal hostname syntax, so "999.1.1.1" would pass
    // the hostname test even though it is plainly a mistyped address. If it
    // looks like nothing but digits and dots, hold it to the IPv4 rules.
    if (/^[0-9.]+$/.test(host) && !IPV4.test(host)) {
      throw new Error('that is not a valid IP address');
    }
    if (!HOSTNAME.test(host) && !IPV4.test(host)) {
      throw new Error('that is not a valid host name or IP address');
    }
  }

  if (port) {
    if (!/^\d{1,5}$/.test(port)) throw new Error('that is not a valid port');
    const n = Number(port);
    if (n < 1 || n > 65535) throw new Error('that is not a valid port');
  }

  return { host, port, spec: port ? host + ':' + port : host };
}

/*
 * How each client wants to be told where to go. Ordered by preference: the
 * FreeRDP family first since it is the most capable and most widely installed,
 * then Remmina, then rdesktop for older systems.
 */
const LINUX_CLIENTS = [
  { bin: 'xfreerdp3', args: (spec) => ['/v:' + spec] },
  { bin: 'xfreerdp', args: (spec) => ['/v:' + spec] },
  { bin: 'sdl-freerdp', args: (spec) => ['/v:' + spec] },
  { bin: 'remmina', args: (spec) => ['-c', 'rdp://' + spec] },
  { bin: 'rdesktop', args: (spec) => [spec] },
];

module.exports = { parseHost, LINUX_CLIENTS };
