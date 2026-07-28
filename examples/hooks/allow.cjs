let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const context = input.trim() ? JSON.parse(input) : {};
  const message = context.event
    ? `Checked lifecycle event: ${context.event}`
    : "Lifecycle check completed";
  process.stdout.write(`${JSON.stringify({ allow: true, message })}\n`);
});
