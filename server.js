const app = require('./app');
const { port } = require('./config');

app.listen(port, () => {
  console.log(`Relativity backend running on http://localhost:${port}`);
});
