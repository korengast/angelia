/** One table of Node versions for every test of the CVE-2026-111497 check (src/daemon/node-fix.ts and install.sh). */
export const ACCEPT = ['22.23.4', '22.23.10', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0'];
export const REFUSE = ['20.19.0', '21.7.3', '22.23.3', '23.9.0', '24.22.0', '25.1.0', '26.12.0', '', '22', 'abc', 'v22.23.4', '22.23.4-pre', '26.12.1-rc.1'];
