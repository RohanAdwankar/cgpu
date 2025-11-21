#!/usr/bin/env node
console.log(JSON.stringify({
  response: "Mock response",
  stats: { total_tokens: 10, input_tokens: 5, output_tokens: 5 }
}));
