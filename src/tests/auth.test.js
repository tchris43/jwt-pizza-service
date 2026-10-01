if (globalThis.process?.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

const request = require('supertest');
const app = require('../service');

let testUser;
let testUserAuthToken;

const { Role, DB } = require('../database/database.js');

// ---------- setup helpers ----------
// these only build test data; every request a test is checking is written out in the test itself

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

// registers a brand-new diner; user keeps its password so it can log in again
async function registerNewUser(name = randomName()) {
  const user = { name, email: randomName() + '@test.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(user);
  return { user: { ...user, id: registerRes.body.user.id }, token: registerRes.body.token };
}

// creates a new admin, logs them in, and returns both
async function loginNewAdmin() {
  const admin = await createAdminUser();
  const loginRes = await request(app).put('/api/auth').send(admin);
  return { admin, adminAuthToken: loginRes.body.token };
}

// a new admin, their franchise, and one store in it
async function createFranchiseWithStore() {
  const { admin, adminAuthToken } = await loginNewAdmin();
  const franchiseRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${adminAuthToken}`).send({ admins: [admin], name: randomName() });
  const franchiseId = franchiseRes.body.id;
  const storeRes = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${adminAuthToken}`).send({ name: randomName() });
  return { adminAuthToken, franchiseId, storeId: storeRes.body.id };
}

// ---------- tests ----------

beforeAll(async () => {
  ({ user: testUser, token: testUserAuthToken } = await registerNewUser('pizza diner'));
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  const user = { ...testUser, roles: [{ role: 'diner' }] };
  delete user.password;
  expect(loginRes.body.user).toMatchObject(user);
});

test('update user', async () => {
  const { admin, adminAuthToken } = await loginNewAdmin();
  const updatedUser = {
    name: randomName(),
    email: `${randomName()}@admin.com`,
    password: 'updatedpassword',
  };

  const updateUserRes = await request(app)
    .put(`/api/user/${admin.id}`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send(updatedUser);

  expect(updateUserRes.status).toBe(200);
  // Add response and re-login assertions here as the update behavior is expanded.
  expect(updateUserRes.body.user.email).toBe(updatedUser.email);

  const updatedUser2 = {
    name: randomName(),
    email: `${randomName()}@jwt.com`,
    password: 'normalPassword',
  };

  const updateUserRes2 = await request(app)
    .put(`/api/user/${admin.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(updatedUser2);

  expect(updateUserRes2.status).toBe(403);


});

test('get menu', async () => {
  const menuRes = await request(app).get('/api/order/menu').set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Crusty' })]));
});

test('admin can create franchise, diner cannot', async () => {
  const { admin, adminAuthToken } = await loginNewAdmin();
  const franchiseRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${adminAuthToken}`).send({ admins: [admin], name: randomName() });
  expect(franchiseRes.status).toBe(200);

  const dinerFranchiseRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${testUserAuthToken}`).send({ admins: [testUser], name: randomName() });
  expect(dinerFranchiseRes.status).toBe(403);
});

test('admin can create a store', async () => {
  const { admin, adminAuthToken } = await loginNewAdmin();
  const franchiseRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${adminAuthToken}`).send({ admins: [admin], name: randomName() });
  const franchiseId = franchiseRes.body.id;

  const storeRes = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${adminAuthToken}`).send({ name: randomName() });
  expect(storeRes.status).toBe(200);

  const dinerStoreRes = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${testUserAuthToken}`).send({ name: randomName() });
  expect(dinerStoreRes.status).toBe(403);
});

test('create order', async () => {
  // a franchise and a store for the order to use
  const { franchiseId, storeId } = await createFranchiseWithStore();

  // a valid item comes from the menu (addDinerOrder needs menuId, description, price)
  const menuRes = await request(app).get('/api/order/menu');
  const menuItem = menuRes.body[0];
  const item = { menuId: menuItem.id, description: menuItem.title, price: menuItem.price };

  const order = { franchiseId: franchiseId, storeId: storeId, items: [item] };
  const orderRes = await request(app).post('/api/order').set('Authorization', `Bearer ${testUserAuthToken}`).send(order);
  expect(orderRes.status).toBe(200);
});

test('delete store', async () => {
  // setup: a franchise and a store in it to delete
  const { adminAuthToken, franchiseId, storeId } = await createFranchiseWithStore();

  // diner tries first, while the store still exists, and is refused
  const dinerDeleteRes = await request(app).delete(`/api/franchise/${franchiseId}/store/${storeId}`).set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(dinerDeleteRes.status).toBe(403);

  // admin deletes the store
  const deleteRes = await request(app).delete(`/api/franchise/${franchiseId}/store/${storeId}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(deleteRes.status).toBe(200);
});

test('get user franchises', async () => {
  // setup: a new user who will own the franchise
  const { user: owner } = await registerNewUser();

  // setup: an admin creates a franchise with the new user as its admin (this gives them the franchisee role)
  const { adminAuthToken } = await loginNewAdmin();
  const franchiseRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${adminAuthToken}`).send({ admins: [{ email: owner.email }], name: randomName() });
  const franchiseId = franchiseRes.body.id;

  const franchises = await DB.getUserFranchises(owner.id);
  expect(franchises.length).toBe(1);
  expect(franchises[0].id).toBe(franchiseId);
});

test('get franchises', async () => {
  // setup: one franchise with a unique name, so we can search for exactly this one
  const { admin, adminAuthToken } = await loginNewAdmin();
  const franchiseName = randomName();
  const franchiseRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${adminAuthToken}`).send({ admins: [admin], name: franchiseName });
  const franchiseId = franchiseRes.body.id;
  expect(franchiseRes.status).toBe(200); // make sure the franchise exists before testing the list

  // not logged in: the name filter goes in the URL's query string, so only our franchise comes back
  const listRes = await request(app).get(`/api/franchise?name=${franchiseName}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body.more).toBe(false);
  expect(listRes.body.franchises.length).toBe(1);
  expect(listRes.body.franchises[0]).toMatchObject({ id: franchiseId, name: franchiseName, stores: [] });
  expect(listRes.body.franchises[0].admins).toBeUndefined(); // non-admins don't see who runs it

  // logged in as admin: same franchise, but with the extra admin details
  const adminListRes = await request(app).get(`/api/franchise?name=${franchiseName}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(adminListRes.status).toBe(200);
  expect(adminListRes.body.franchises[0].admins[0].email).toBe(admin.email);
});
