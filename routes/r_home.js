var express = require('express');
var r = express.Router();

/* GET home page. */
r.get('/', function(req, res, next) {
    res.render('home')
});

module.exports = r;
