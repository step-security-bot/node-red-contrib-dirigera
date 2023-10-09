module.exports = function (RED) {
  'use strict'
  const { Authenticate, Dirigera } = require('dirigera-simple')
  function parseToList (devicesRaw) {
    if (!devicesRaw) return null
    const connectedDevices = {}
    for (const device of devicesRaw) {
      if (device.type === 'gateway') continue

      if (!Object.prototype.hasOwnProperty.call(connectedDevices, device.type)) {
        connectedDevices[device.type] = {}
      }
      if (!Object.prototype.hasOwnProperty.call(connectedDevices[device.type], device.room.name)) {
        connectedDevices[device.type][device.room.name] = {
          canReceive: device.capabilities.canReceive,
          list: [],
          id: device.room.id
        }
      }
      const newIndex = connectedDevices[device.type][device.room.name].list.push({
        id: device.id,
        name: device.attributes.customName,
        createdAt: device.createdAt,
        isReachable: device.isReachable,
        lastSeen: device.lastSeen
      })
      if (Object.prototype.hasOwnProperty.call(device.attributes, 'batteryPercentage')) {
        connectedDevices[device.type][device.room.name].list[newIndex - 1].batteryPercentage = device.attributes.batteryPercentage
      }
      if (device.capabilities.canReceive) {
        device.capabilities.canReceive.forEach(element => {
          if (Object.prototype.hasOwnProperty.call(device.attributes, element)) {
            connectedDevices[device.type][device.room.name].list[newIndex - 1][element] = device.attributes[element]
          }
        })
      }
    }
    return connectedDevices
  }
  // RED.httpAdmin.get('/ikeaDirigera/discover', RED.auth.needsPermission('dirigera.read'), async function (req, res) {
  //   console.log('starting /ikeaDirigera/discover', req.query)
  //   const disc = new Discover()
  //   disc.lookForDevice(data => {
  //     console.log(data)
  //     res.send(data)
  //     res.sendStatus(200)
  //   })
  //   res.setTimeout(4000, function () {
  //     if (store.temp2) {
  //       res.send(JSON.stringify(store.temp2))
  //     } else {
  //       console.log('Request has timed out.')
  //       res.sendStatus(408)
  //     }
  //   })
  // })
  RED.httpAdmin.get('/ikeaDirigera/auth', RED.auth.needsPermission('dirigera.write'), function (req, res) {
    // console.log('/ikeaDirigera/auth > req.query', JSON.stringify(req.query))
    const onError = (errorText) => {
      if (done) return
      res.json(JSON.stringify({ error: errorText }))
      done = true
    }
    let done = false
    const hubAddress = String(req.query.hubAddress)
    if (!hubAddress) {
      onError('Hub address empty. Missing ip or hostname to use.')
      return
    }
    res.setTimeout(60000, function () {
      onError('Button push was not registered at address: ' + hubAddress)
    })
    // console.log('running auth against ip ' + hubAddress)
    const hubOptions = {}
    hubOptions.ip = hubAddress
    hubOptions.clientName = req.query.clientName ? req.query.clientName : 'node-red-dirigera'
    /* eslint-disable no-new */
    new Authenticate(hubOptions, data => {
      if (data.error) {
        onError('/ikeaDirigera/auth > Authenticate callback:err> ' + String(data.message))
        return
      }
      res.json(JSON.stringify(data))
      done = true
    })
  })
  RED.httpAdmin.get('/ikeaDirigera/dirigera', RED.auth.needsPermission('dirigera.read'), function (req, res) {
    const node = RED.nodes.getNode(req.query.nodeId)
    if (node.dirigeraClient && node.dirigeraClient.state.loaded) {
      node.devices = parseToList(node.dirigeraClient.devices)
      res.json(JSON.stringify(node.devices))
    } else {
      res.sendStatus(404)
    }
  })
  function DirigeraConfigNode (n) {
    RED.nodes.createNode(this, n)
    const node = this
    if (!node.credentials.hubAddress) return
    node.dirigeraClient = new Dirigera(
      node.credentials.hubAddress,
      node.credentials.hubAccessCode
      , data => {
        if (data.error) {
          node.error('Dirigera config error: ' + data.message || data)
          return
        }
        node.dirigeraClient.setDebug(true)
        node.dirigeraClient.getDeviceList(devices => {
          if (devices.error) {
            node.devices = null
            node.warn('Dirigera hub error: ' + String(devices.message))
            return
          }
          node.devices = parseToList(devices)
        })
      })
  }
  RED.nodes.registerType('dirigera-config', DirigeraConfigNode, {
    credentials: {
      hubAddress: { type: 'text' },
      hubAccessCode: { type: 'text' }
    }
  })

  function DirigeraNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    this.config = config
    node.on('input', async function (msg, send, done) {
      node.server = RED.nodes.getNode(config.server)
      node.status({ fill: '', text: '' })
      try {
        if (!node.server || !node.server.dirigeraClient) {
          throw new Error('Unknown config error')
        }
        node.server.dirigeraClient.getDeviceList(devices => {
          if (devices.error) {
            node.devices = null
            throw new Error('Dirigera hub error: ' + String(devices.message))
          }
          node.devices = parseToList(devices)
          if (!(node.config.choiceType in node.server.devices)) {
            throw new Error(`Object does not have key: ${node.config.choiceType}`)
          }
          if (!(node.config.choiceRoom in node.server.devices[node.config.choiceType])) {
            throw new Error(`Object does not have key: ${node.config.choiceRoom}`)
          }
          if (msg.cmd) {
            msg.cmd = String(msg.cmd)
            if (!node.server.devices[node.config.choiceType][node.config.choiceRoom].canReceive.includes(msg.cmd)) {
              throw new Error(`${node.config.choiceType} does accept cmd: ${msg.cmd}, try: ${node.server.devices[node.config.choiceType][node.config.choiceRoom].canReceive.join(', ')}.`)
            }
            msg.payload = { [msg.cmd]: msg.payload }
            node.server.dirigeraClient.setRoomAttribute(node.server.devices[node.config.choiceType][node.config.choiceRoom].id, msg.payload, null, node.config.choiceType)
            msg.id = node.server.devices[node.config.choiceType][node.config.choiceRoom].id
          } else {
            msg.payload = node.server.devices[node.config.choiceType][node.config.choiceRoom].list
            msg.cmd = node.server.devices[node.config.choiceType][node.config.choiceRoom].canReceive
          }
          msg.topic = node.config.choiceType
          send(msg)
          done()
        })
      } catch (error) {
        node.status({ fill: 'red', text: error.message || error })
        done(error.message || error)
      }
    })
  }
  RED.nodes.registerType('dirigera', DirigeraNode)
}
