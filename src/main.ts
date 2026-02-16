import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element.");
}

app.innerHTML = `
  <main class="shell">
    <h1>Bisquits</h1>
    <p>TypeScript + Vite setup is ready.</p>
    <p>Next step: port the Processing sketch into game systems.</p>
  </main>
`;
