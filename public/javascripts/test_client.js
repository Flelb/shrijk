const clientio = io('https://shrijk-backend.herokuapp.com/')

clientio.on('connect', () => {
	console.log("connected.")
})

function status() {
	clientio.emit('status')
}