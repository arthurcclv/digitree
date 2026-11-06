// Reads `docker compose config --format json` on stdin and prints one field of
// one service, for the shell tests that check what docker-compose.yml resolves
// to (compose.sh, files.sh, martin.sh).
//
//   docker compose config --format json | node test/compose-config.mjs <service> image
//     the service's image
//   docker compose config --format json | node test/compose-config.mjs <service> ports
//     "host_ip:published:target" for each published port, one per line
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const [service, field] = process.argv.slice(2);
  const svc = JSON.parse(input).services[service];
  if (!svc) throw new Error(`no service ${service}`);
  if (field === "image") console.log(svc.image);
  else if (field === "ports")
    for (const p of svc.ports ?? [])
      console.log(`${p.host_ip ?? ""}:${p.published}:${p.target}`);
  else throw new Error(`unknown field ${field}: want image or ports`);
});
