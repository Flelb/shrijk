#!/usr/bin/env node

// Module dependencies.
var app = require('../app')
var debug = require('debug')('backend:server')

// Start Server ( incl https)
const fs = require('fs')
const key = fs.readFileSync('./public/certificates/key.pem')
const cert = fs.readFileSync('./public/certificates/cert.pem')
// var server = require('https').createServer({ key: key, cert: cert }, app)
var server = require('http').createServer(app)

// Get port from environment and store in Express.
const port = normalizePort(process.env.PORT || '9000')
app.set('port', port)

// Listen on provided port, on all network interfaces.
server.listen(port, () => {
	console.log('> LISTEN ON 9000\n')
})
server.on('error', onError)
server.on('listening', onListening)

// -------------------------------------------------------------------------------------

// Socket Kram
const io = require('socket.io')(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"]
	}
})

var pain = new Map()		// user.id -> roomcode
var users = new Map()		// user.id -> {name, avatar, newVote, points}
var all_rooms = new Map() 	// code -> {room}

io.on('connection', socket => {
	console.log('> CLIENT CONNECTED (id: ' + socket.id + ')\n')

	socket.on('host_room', (data, callback) => {
		// let room = "1234"
		let code = generateRoomCode()
		console.log('> HOST ROOM (' + code + ')\n')
		socket.join(code)

		var new_room = {
			host: socket.id,		// host.id
			users: [socket.id],		// list von user.id's
			game: "",				// gamename
			votes: new Map(),		// user.id -> game
			pyp_chosen: undefined,	// eine user.id
			pyp_question: undefined,// die aktuelle question
			pyp_votes: new Map(),	// user.id -> choice
			pyp_quests: [],			// liste von quest-objekt paaren, die noch nicht dran waren
			pyp_round_c: 0,			// anzahl der runden des aktuellen spiels
			sl_round_c: 0,			// anzahl der runden des aktuellen spiels
			sl_statement: undefined,
			sl_votes: new Map(),
			sl_states: []
		}
		
		all_rooms.set(code, new_room)

		pain.set(socket.id, code)
		users.set(socket.id, {
			name: data.u_name, // should probably change this and in the HRP too :)
			avatar: data.u_avatar,
			newVote: false,
			points: 0,
			sid: socket.id
		})
		io.to(socket.id).emit("get_sid", socket.id)
		callback({
			code: code
		})
	})

	socket.on('join_room', (data, callback) => {
		let answer = ""
		let failed = false
		let already_in = false;
		for (let u of all_rooms.get(data.code).users) {
			if(u == socket.id) already_in = true
		}
		
		if (!all_rooms.has(data.code)) {
			answer = "Room doesn't exist."
			failed = true
		} else if(all_rooms.get(data.code).host == socket.id) {
			answer = "Can't host more than one room."
			failed = true
		} else if(all_rooms.get(data.code).game != "") {
			answer = "Room is currently playing a game."
			failed = true
		} else if(already_in) {
			// nichts tun
		} else {
			console.log('> JOIN ROOM (' + data.code + ') ID: '  + socket.id + '\n')
			socket.join(data.code)
			pain.set(socket.id, data.code)
			users.set(socket.id, {
				name: data.user.name,
				avatar: data.user.avatar,
				newVote: false,
				points: 0,
				sid: socket.id
			})

			all_rooms.get(data.code).users.push(socket.id)

			let list = getUsersByRoom(data.code)
			io.to(data.code).emit('user_list', list)
			io.to(socket.id).emit("get_sid", socket.id)
		}

		callback({
			failed: failed,
			answer: answer
		})

	})

	// socket.on('leave_room', () => {
	// 	console.log('> LEAVE\n')
	// 	// socket.disconnect()
	// 	// socket.io.disconnect()
	// 	// we suffer already. may as well use our pain
	// 	leave(socket.id)
	// 	let roomcode = pain.get(socket.id)
	// 	let list = getUsersByRoom(roomcode)

	// 	if (roomcode) io.to(roomcode).emit('user_list', list)
		
	// 	socket.leave(roomcode)

	// 	pain.delete(socket.id)
	// })

	socket.on('disconnect', () => {
		console.log('> DISCO\n')
		leave(socket.id)
		
		// this is the source of pain: we can't update the userlist here without suffering
		let roomcode = pain.get(socket.id)
		let list = getUsersByRoom(roomcode)
		if (roomcode) io.to(roomcode).emit('user_list', list)

		pain.delete(socket.id)
	})

	socket.on('status', () => {
		console.log('\n  ---------------------- S T A T U S ----------------------')
		console.log('> SOCKETS')
		console.log(io.sockets.adapter.rooms)
		console.log('> ROOMS')
		console.log(all_rooms)
		console.log('> USERS')
		console.log(users)
		console.log('  ---------------------------------------------------------\n\n')
	})

	socket.on('vote', (roomcode, game, callback) => {
		console.log('> VOTE: ' + game + ' in ' + roomcode + "\n")
		let voted = process_vote(socket.id, roomcode, game)

		let list = getUsersByRoom(roomcode)
		io.to(roomcode).emit('user_list', list)

		callback({
			newVote: voted
		})
	})

	//game stuff
	socket.on('start_game', (roomcode) => {
		console.log('> GAME STARTED in ' + roomcode + "\n")
		
		let game = count_votes(roomcode)

		delete_votes(roomcode)

		if (game == "sl") {
			sl_load_statements(roomcode)
			sl_start(roomcode)
		} else {
			// current default
			game = "pyp"
			pyp_load_questions(roomcode)
			pyp_start(roomcode)
		}

		io.to(roomcode).emit('started_game', roomcode, game)
	})

	socket.on('end_game', (roomcode) => {
		console.log('> GAME ENDED in ' + roomcode + "\n")
		
		delete_votes(roomcode)

		if(all_rooms.get(roomcode).game == "pyp") {
			io.to(roomcode).emit('ended_game', roomcode, getUsersByRoom(roomcode))
			pyp_end(roomcode) // not yet // update: yet
		}

		if(all_rooms.get(roomcode).game == "sl") {
			io.to(roomcode).emit('ended_game', roomcode, getUsersByRoom(roomcode))
			sl_end(roomcode) // not yet // update: yet
		}
		
	})
	socket.on('return_to_lobby', (roomcode) => {
		console.log('> RETURN TO LOBBY: ' + roomcode + "\n")
		
		// making the members return
		io.to(all_rooms.get(roomcode).host).emit('returning_as_host', roomcode)
		
		for(let u of all_rooms.get(roomcode).users) {
			if (u == all_rooms.get(roomcode).host) continue
			io.to(u).emit('returning_as_player', roomcode)
		}

	})
// -------------------------------------------------------------------------------------

	//spotlight stuff
	socket.on('sl_vote', (roomcode, choice, callback) => {
		console.log('> SL_VOTE: ' + choice + ' in ' + roomcode + "\n")
		let voted = sl_process_vote(socket.id, roomcode, choice)
		
		let list = getUsersByRoom(roomcode)
		io.to(roomcode).emit('user_list', list)

		callback({
			newVote: voted
		})
	})

	
	socket.on("sl_fetch", (roomcode) => {
		let room = all_rooms.get(roomcode)
	
		// preparing the object for sending and doing it
		let gameObject = {
			type: "sl_question",
			data: {"question": room.sl_statement}
		}

		io.to(roomcode).emit('gameObject_update', gameObject)

	})

	// pyp stuff
	socket.on('pyp_vote', (roomcode, choice, callback) => {
		console.log('> PYP_VOTE: ' + choice + ' in ' + roomcode + "\n")
		let voted = pyp_process_vote(socket.id, roomcode, choice)
		
		let list = getUsersByRoom(roomcode)
		io.to(roomcode).emit('user_list', list)

		callback({
			newVote: voted
		})
	})

	socket.on("pyp_fetch", (roomcode) => {
		// if(game != "pyp") return
		
		let room = all_rooms.get(roomcode)
	
		// preparing the object for sending and doing it
		let gameObject = {
			type: "pyp_question",
			data: {"question": room.pyp_question, "user": users.get(room.pyp_chosen)}
		}

		io.to(roomcode).emit('gameObject_update', gameObject)
	})

	socket.on("resume_game", (roomcode) => {
		console.log("RESUME GAME IN BACKEND")
		delete_votes(roomcode)
		if(all_rooms.get(roomcode).game == "pyp"){
			pyp_start(roomcode)
			io.to(roomcode).emit('started_game', roomcode, 'pyp')
		}
		
		if(all_rooms.get(roomcode).game == "sl"){
			sl_start(roomcode)
			io.to(roomcode).emit('started_game', roomcode, 'sl')
		}
		
	})

})

// -------------------------------------------------------------------------------------

function generateRoomCode() {
	let symbols = []
	for (let i = 0; i < 4; i++) {
		let symbol = '?'
		if (Math.random() <= 0.5) {
			symbol = Math.floor(Math.random() * 9 + 1)
			// symbol = Math.floor(Math.random() * 26)
			// symbol = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".charAt(symbol)
		} else {
			symbol = Math.floor(Math.random() * 24)
			symbol = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.charAt(symbol) // no I's no O's
		}
		symbols.push(symbol)
	}

	let code = symbols.toString().replace(',', '').replace(',', '').replace(',', '')

	if (all_rooms.has(code)) {
		return generateRoomCode()
	} else return code
}

function findMeInList(me, list) {
	for (let element of list) {
		if (element.name == me.name
			&& element.avatar.bird_color == me.avatar.bird_color
			&& element.avatar.bird_mood == me.avatar.bird_mood) {
			return me
		}
	}
	return null
}

function process_vote(user, roomcode, game) {
	console.log('> VOTE ' + user + ' ' + roomcode + ' ' + game + "\n")
	var newVote = true
	let room = all_rooms.get(roomcode)

	if(room.votes.has(user)) {
		if(room.votes.get(user) == game) {
			newVote = false
			room.votes.delete(user);
		}
	}


	if (newVote) room.votes.set(user, game)
	all_rooms.set(roomcode, room)

	users.get(user).newVote = newVote
	return newVote
}

function count_votes(roomcode) {
	var count_map = new Map() // game -> count
	var max = 0
	var winner = null
	
	for (const [u, g] of all_rooms.get(roomcode).votes.entries()){
		let game = g
		let count = 0
		
		if (count_map.has(game)) count = count_map.get(game) + 1
		else count = 1

		count_map.set(game, count)
		if (count >= max) {
			winner = game
			max = count
		}
	}

	return winner
}

function delete_votes(roomcode) {
	console.log('> DELETE VOTES of ' + roomcode + "\n")
	all_rooms.get(roomcode).votes.clear()
	all_rooms.get(roomcode).pyp_votes.clear()
	all_rooms.get(roomcode).sl_votes.clear()

	// waypoint
	for(u of all_rooms.get(roomcode).users) {
		users.get(u).newVote = false
	}
}

function delete_vote(user) {
	console.log('> DELETE VOTE of ' + user + "\n")
	all_rooms.get(pain.get(user)).votes.delete(user)
}

function getUsersByRoom(roomcode) {
	
	let ids = io.sockets.adapter.rooms.get(roomcode)
	if(!ids) return null
	
	let room = all_rooms.get(roomcode)
	if(!room) return null

	let hostid = room.host
	let result = [users.get(hostid)]

	for (let id of ids) {
		if (hostid === id) continue
		let data = users.get(id)
		result.push(data)
	}

	return result
}

function leave(userID) {
	// remove global reference to the user
	users.delete(userID)
	
	// if there is no room, stop
	if(!all_rooms.get(pain.get(userID))) return

	// delete all the user's votes
	delete_vote(userID)
	
	// remove user out of room
	let r = all_rooms.get(pain.get(userID))
	r.users.splice(r.users.indexOf(userID), 1)

	// if the room still exist, appoint new Host, if not > torch the room
	if(r.users.length > 0) {
		r.host = r.users[0]
		all_rooms.set(pain.get(userID), r)
		io.to(r.host).emit('promotion', pain.get(userID))
	} else {
		delete_votes(pain.get(userID))
		all_rooms.delete(pain.get(userID))
	}

}
// -------------------------------------------------------------------------------------
// spotlight stuff oohoooo [to the theme of ducktales]
function sl_start(roomcode) {
	all_rooms.get(roomcode).game = "sl"
	sl_select_statement(roomcode)
	all_rooms.get(roomcode).sl_round_c += 1
	
	let list = getUsersByRoom(roomcode)
	io.to(roomcode).emit('user_list', list)
}


function sl_end(roomcode) {
	// dann am ende werte zurücksetzen
	let currentroom = all_rooms.get(roomcode)
	currentroom.game = ""	
	currentroom.votes = new Map()
	currentroom.sl_statement = undefined
	currentroom.sl_votes = new Map()
	currentroom.sl_states = []	
	currentroom.sl_round_c = 0

	for(let u of all_rooms.get(roomcode).users) {
		users.get(u).points = 0
	}
	
	all_rooms.set(roomcode, currentroom)
}


function sl_load_statements(roomcode) {
	var data = JSON.parse(fs.readFileSync("./Games/Spotlight/Statements.json"))
	
	var stateslist = []
	for (let /*json*/statem of Object.keys(data)) {
		stateslist.push(data[statem])
	}
	all_rooms.get(roomcode).sl_states = stateslist
}


function sl_select_statement(roomcode) {
	// get room and reload questions if the room is empty
	var room = all_rooms.get(roomcode)
	if (!room.sl_states || room.sl_states.length == 0) sl_load_statements(roomcode)

	// select a random question and remove it from the available list
	var rand_index = Math.floor(Math.random() * all_rooms.get(roomcode).sl_states.length)
	room.sl_statement = room.sl_states[rand_index]
	room.sl_states.splice(rand_index, 1)

	all_rooms.set(roomcode, room)
	
}

function sl_process_vote(user, roomcode, choice) {
	console.log('> SL CHOICE ' + user + ' ' + roomcode + ' ' + choice + "\n")
	var newVote = true
	let room = all_rooms.get(roomcode)

	if(room.sl_votes.has(user)) {
		if(room.sl_votes.get(user) == choice) {
			newVote = false
			room.sl_votes.delete(user);
		}
	}
	if (newVote) room.sl_votes.set(user, choice)


	if(room.sl_votes.size >= getUsersByRoom(roomcode).length){
		console.log(">>>> RUNDE IST VORBEI")

		let log_map = count_sl_votes(roomcode)
		
		var sl_over = all_rooms.get(roomcode).sl_round_c >= (all_rooms.get(roomcode).users.length * 2)

		let log_map_matched = []
		let log_map_unmatched = []
		for (const [user, match] of log_map) {
			if(match) log_map_matched.push(users.get(user))
			else log_map_unmatched.push(users.get(user))
		}

		var gameObject = {
			type: "sl_round_over",
			data: {
				"host": room.host,
				"sl_over": sl_over,
				"question": room.sl_statement,
				"votes": room.sl_votes,
				"log_map_matched": log_map_matched,
				"log_map_unmatched": log_map_unmatched
			}
		}

		io.to(roomcode).emit("gameObject_update", gameObject)
	}
	
	users.get(user).newVote = newVote
	return newVote

}

function count_sl_votes(roomcode) {
	var log_map = new Map() // userobj -> matched
	var cRoom = all_rooms.get(roomcode)
	votes = cRoom.sl_votes


	for(let u of cRoom.users) {	
		let chosenChoice = votes.get(votes.get(u))
			
		if(u == chosenChoice) {
			log_map.set(u, true)
			users.get(u).points -=1
		} else {
			log_map.set(u, false)
			users.get(u).points +=2
		}
	}

	return log_map	
}
// -------------------------------------------------------------------------------------
// pyp stuff oohoooo [to the theme of ducktales]

// spiel startet, backend broadcastet an den room die erste question und person
// frontend hat 2 verschiedene Strings über den buttons:
//		Ich bin die Choice-Person	: "Würdest DU eher...:"
//		Ich bin jemand anderes		: "Würde Person [name] eher..."

// dann voted jeder und das backend counted. Vermerkt separat den Vote der Main Person.
// sobald alle gevoted haben evaluated das backend die ergebnisse und verrechnet sie

// das backend broadcastet die Daten schön ans frontend, was die dann darstellt
// der host hat dann einen button für "next question"

// das triggert im backend, dass die nächste Frage gesendet wird mit der next person
// repeat so lange bis die User Liste ein mal durch ist

function pyp_start(roomcode) {
	all_rooms.get(roomcode).game = "pyp"
	pyp_select_question(roomcode)
	pyp_elect_chosen(roomcode)
	all_rooms.get(roomcode).pyp_round_c += 1

	
	let list = getUsersByRoom(roomcode)
	io.to(roomcode).emit('user_list', list)
		
}

function pyp_end(roomcode) {
	// dann am ende werte zurücksetzen
	let currentroom = all_rooms.get(roomcode)
	currentroom.game = ""	
	currentroom.votes = new Map()
	currentroom.pyp_chosen = undefined
	currentroom.pyp_question = undefined
	currentroom.pyp_votes = new Map()
	currentroom.pyp_quests = []	
	currentroom.pyp_round_c = 0

	for(let u of all_rooms.get(roomcode).users) {
		users.get(u).points = 0
	}
	
	all_rooms.set(roomcode, currentroom)
}

function pyp_load_questions(roomcode) {
	var data = JSON.parse(fs.readFileSync("./Games/PickYourPoison/Statements.json"))
	var questionlist = []
	for (let key of Object.keys(data)) {
		questionlist.push(data[key])
	}
	all_rooms.get(roomcode).pyp_quests = questionlist
}

function pyp_elect_chosen(roomcode) {
	// getting the userlist in room:
	// var user_list = getUsersByRoom(roomcode)
	var user_list = all_rooms.get(roomcode).users
	var current_chosen = all_rooms.get(roomcode).pyp_chosen

	//search for chosen, if none is found: make one
	for (let i = 0; i < user_list.length; i++) {
		if (!current_chosen) {
			current_chosen = user_list[0]
			break;
		} else if (user_list[i] == current_chosen) {
			// this currently cycles, even though it would result in the end of the game
			current_chosen = (user_list[i + 1]) ? user_list[i + 1] : user_list[0]
			break;
		}
	}

	all_rooms.get(roomcode).pyp_chosen = current_chosen;
}

function pyp_select_question(roomcode) {
	
	// get room and reload questions if the room is empty
	var room = all_rooms.get(roomcode)
	if (!room.pyp_quests || room.pyp_quests.length == 0) pyp_load_questions(roomcode)

	// select a random question and remove it from the available list
	var rand_index = Math.floor(Math.random() * all_rooms.get(roomcode).pyp_quests.length)
	room.pyp_question = room.pyp_quests[rand_index]
	room.pyp_quests.splice(rand_index, 1)

	all_rooms.set(roomcode, room)
}

function pyp_process_vote(user, roomcode, choice) {
	console.log('> PYP CHOICE ' + user + ' ' + roomcode + ' ' + choice + "\n")
	var newVote = true
	let room = all_rooms.get(roomcode)

	if(room.pyp_votes.has(user)) {
		if(room.pyp_votes.get(user) == choice) {
			newVote = false
			room.pyp_votes.delete(user);
		}
	}
	if (newVote) room.pyp_votes.set(user, choice)


	// has everybody voted? >> send event to room >> round over
	// >> frontend needs to be edited
	// >> next question needs to be displayed after a timer
	if(room.pyp_votes.size >= getUsersByRoom(roomcode).length){
		var log_map = count_pyp_votes(roomcode)
		
		console.log(">>>> PYP ROUND OVER")

		let log_map_winners = []
		let log_map_losers = []
		for (const [user, guess] of log_map) {
			if(guess) log_map_winners.push(user)
			else log_map_losers.push(user)
		}
		
		var pyp_over = all_rooms.get(roomcode).pyp_round_c >= (all_rooms.get(roomcode).users.length * 2)
		// var pyp_over = all_rooms.get(roomcode).pyp_round_c >= (all_rooms.get(roomcode).users.length)

		var gameObject = {
			type: "pyp_round_over",
			data: {
				"pyp_over": pyp_over,
				"question": room.pyp_question,
				"user": users.get(room.pyp_chosen),
				"log_map_winners": log_map_winners,
				"log_map_losers": log_map_losers, // loggy
			}
		}
		io.to(roomcode).emit("gameObject_update", gameObject)
	}
	
	users.get(user).newVote = newVote
	return newVote
}

// count dooku?
function count_pyp_votes(roomcode) {
	var log_map = new Map() // userobj -> choice
	var chosen_choice = all_rooms.get(roomcode).pyp_votes.get(all_rooms.get(roomcode).pyp_chosen)
	guess_correct_count = 0
	

	for (const [usr, choice] of all_rooms.get(roomcode).pyp_votes.entries()){
		if(usr == all_rooms.get(roomcode).pyp_chosen) continue
		
		//map of userobjects and if they voted right or wrong
		guess_correct = choice == chosen_choice

		if(guess_correct) {
			// let p = users.get(usr).points + 5 //vlt. andere Punkte
			users.get(usr).points += 5
			guess_correct_count++	
		} else {
			// let p = users.get(usr).points - 2 //vlt. andere Punkte
			users.get(usr).points -= 2
		}	
		
		log_map.set(users.get(usr), guess_correct)

	}
	
	if(guess_correct_count != 0){
		users.get(all_rooms.get(roomcode).pyp_chosen).points += 3
	}
	return log_map

}

// -------------------------------------------------------------------------------------

// Normalize a port into a number, string, or false.
function normalizePort(val) {
	var port = parseInt(val, 10)
	if (isNaN(port)) return val
	if (port >= 0) return port
	return false
}

// Event listener for HTTP server "error" event.
function onError(error) {
	if (error.syscall !== 'listen') throw error

	var bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port

	// handle specific listen errors with friendly messages
	switch (error.code) {
		case 'EACCES':
			console.error(bind + ' requires elevated privileges')
			process.exit(1)
			break
		case 'EADDRINUSE':
			console.error(bind + ' is already in use')
			process.exit(1)
			break
		default:
			throw error
	}
	
}

// Event listener for HTTP server "listening" event.
function onListening() {
	var addr = server.address()
	var bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port
	debug('Listening on ' + bind)
}

