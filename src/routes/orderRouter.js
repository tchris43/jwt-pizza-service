const express = require('express');
const config = require('../config.js');
const metrics = require('../metrics.js');
const { Role, DB } = require('../database/database.js');
const { authRouter } = require('./authRouter.js');
const { asyncHandler, StatusCodeError } = require('../endpointHelper.js');

const orderRouter = express.Router();

orderRouter.docs = [
  {
    method: 'GET',
    path: '/api/order/menu',
    description: 'Get the pizza menu',
    example: `curl localhost:3000/api/order/menu`,
    response: [{ id: 1, title: 'Veggie', image: 'pizza1.png', price: 0.0038, description: 'A garden of delight' }],
  },
  {
    method: 'PUT',
    path: '/api/order/menu',
    requiresAuth: true,
    description: 'Add an item to the menu',
    example: `curl -X PUT localhost:3000/api/order/menu -H 'Content-Type: application/json' -d '{ "title":"Student", "description": "No topping, no sauce, just carbs", "image":"pizza9.png", "price": 0.0001 }'  -H 'Authorization: Bearer tttttt'`,
    response: [{ id: 1, title: 'Student', description: 'No topping, no sauce, just carbs', image: 'pizza9.png', price: 0.0001 }],
  },
  {
    method: 'GET',
    path: '/api/order',
    requiresAuth: true,
    description: 'Get the orders for the authenticated user',
    example: `curl -X GET localhost:3000/api/order  -H 'Authorization: Bearer tttttt'`,
    response: { dinerId: 4, orders: [{ id: 1, franchiseId: 1, storeId: 1, date: '2024-06-05T05:14:40.000Z', items: [{ id: 1, menuId: 1, description: 'Veggie', price: 0.05 }] }], page: 1 },
  },
  {
    method: 'POST',
    path: '/api/order',
    requiresAuth: true,
    description: 'Create a order for the authenticated user',
    example: `curl -X POST localhost:3000/api/order -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}'  -H 'Authorization: Bearer tttttt'`,
    response: { order: { franchiseId: 1, storeId: 1, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }], id: 1 }, jwt: '1111111111' },
  },
];

// getMenu
orderRouter.get(
  '/menu',
  asyncHandler(async (req, res) => {
    res.send(await DB.getMenu());
  })
);

// addMenuItem
orderRouter.put(
  '/menu',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      throw new StatusCodeError('unable to add menu item', 403);
    }

    const addMenuItemReq = req.body;
    await DB.addMenuItem(addMenuItemReq);
    res.send(await DB.getMenu());
  })
);

// getOrders
orderRouter.get(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    res.json(await DB.getOrders(req.user, req.query.page));
  })
);

// createOrder
orderRouter.post(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const orderReq = req.body;
    const order = await DB.addDinerOrder(req.user, orderReq);

    // In this app, each entry in order.items represents one pizza.
    const pizzaCount = order.items.length;
    const orderPrice = order.items.reduce((total, item) => total + Number(item.price || 0), 0);

    // Start timing only when we are about to call the Pizza Factory. This keeps
    // database time out of the separate factory-creation latency measurement.
    const factoryStartedAt = Date.now();
    let r;
    let j;
    try {
      r = await fetch(`${config.factory.url}/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${config.factory.apiKey}` },
        body: JSON.stringify({ diner: { id: req.user.id, name: req.user.name, email: req.user.email }, order }),
      });
      // Include reading the response body in the time it took to get the result.
      j = await r.json();
    } catch (error) {
      // Network errors and unreadable responses are failed factory attempts too.
      metrics.pizzaPurchase(false, Date.now() - factoryStartedAt, 0, pizzaCount);
      throw error;
    }

    const factoryLatencyMs = Date.now() - factoryStartedAt;
    if (r.ok) {
      // Only a factory-accepted order counts as sold or earns revenue.
      metrics.pizzaPurchase(true, factoryLatencyMs, orderPrice, pizzaCount);
      res.send({ order, followLinkToEndChaos: j.reportUrl, jwt: j.jwt });
    } else {
      // Count this failed order, but do not add its pizzas or price to sales.
      metrics.pizzaPurchase(false, factoryLatencyMs, 0, pizzaCount);
      res.status(500).send({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: j.reportUrl });
    }
  })
);

module.exports = orderRouter;
