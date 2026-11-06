#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { await main(process.cwd(), process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
