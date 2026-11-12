const express = require('express');
const app = express();

let greeting = 'hello';

app.get('/greet/:name', (req, res) => {
  res.send({ [greeting]: req.params.name });
});

app.listen(3000, function () {
  console.log(`Listening on port 3000`);
});
