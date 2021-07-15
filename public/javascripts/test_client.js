const clientio = io('https://shrijk-backend.herokuapp.com/')

clientio.on('connect', () => {
	console.log("connected.")
})

function status() {
    console.log("STATUS CALLED")
	clientio.emit('status')
}