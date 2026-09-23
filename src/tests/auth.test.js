const request = require('supertest');
const app = require('../service');
// const { DB } = require('./database/database.js');
// const { Role } = require()

// function randomName() {
//   return Math.random().toString(36).substring(2, 12);
// }

// async function createAdminUser() {
//   let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
//   user.name = randomName();
//   user.email = user.name + '@admin.com';

//   await DB.addUser(user);
//   user.password = 'toomanysecrets';

//   return user;
// }


const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  const user = { ...testUser, roles: [{ role: 'diner' }] };
  delete user.password;
  expect(loginRes.body.user).toMatchObject(user);
});

test('get menu', async () => {
  const menuRes = await request(app).get('/api/order/menu').set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Crusty' })]));
});


