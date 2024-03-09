import React, { useEffect, useRef, useState } from "react";
import "./App.css";
import io from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";
const socket = io("https://localhost:3001", { secure: true });

function VideoComponent({ stream }) {
  const videoRef = useRef();

  useEffect(() => {
    if (videoRef.current && stream instanceof MediaStream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <>
      <video ref={videoRef} autoPlay playsInline muted></video>
    </>
  );
}

function App() {
  const isMounted = useRef(true);
  const [rtpCapabilities, SetrtpCapabilities] = useState();
  const [audioProducerCreated, setAudioProducerCreated] = useState(false);
  const [videoProducerCreated, setVideoProducerCreated] = useState(false);
  const [peers, Setpeers] = useState([]);

  let roomName = "yash";
  let device;
  let producerTransport;
  let consumerTransports = [];
  let audioProducer;
  let videoProducer;
  let consumer;
  let isProducer = false;

  let params = {
    // mediasoup params
    encodings: [
      {
        rid: "r0",
        maxBitrate: 100000,
        scalabilityMode: "S1T3",
      },
      {
        rid: "r1",
        maxBitrate: 300000,
        scalabilityMode: "S1T3",
      },
      {
        rid: "r2",
        maxBitrate: 900000,
        scalabilityMode: "S1T3",
      },
    ],
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
    codecOptions: {
      videoGoogleStartBitrate: 1000,
    },
  };

  let audioParams;
  let videoParams = { params };
  let consumingTransports = [];

  useEffect(() => {
    console.log("Attempting to connect to socket...");

    if (isMounted.current) {
      // Your logic here

      socket.on("connect", () => {
        console.log(`socket connected ${socket.id}`);
        getLocalStream();
      });
      socket.on("connection-success", ({ socketId }) => {
        console.log(socketId);
      });
      const getLocalStream = () => {
        console.log("getting params");
        navigator.mediaDevices
          .getUserMedia({
            audio: true,
            video: {
              width: {
                min: 640,
                max: 1920,
              },
              height: {
                min: 400,
                max: 1080,
              },
            },
          })
          .then(streamSuccess)
          .catch((error) => {
            console.log(error.message);
          });
      };
      const streamSuccess = (stream) => {
        console.log(stream);
        audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
        videoParams = { track: stream.getVideoTracks()[0], ...videoParams };

        joinRoom();
      };
      const joinRoom = async () => {
        socket.emit("joinRoom", { roomName }, async (data) => {
          console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);
          // console.log(JSON.stringify(data.rtpCapabilities, null, 2))
          // we assign to local variable and will be used when
          // loading the client Device (see createDevice above)
          let rtpCapabilitiesa = data.rtpCapabilities;
          await createDevice(rtpCapabilitiesa);

          // once we have rtpCapabilities from the Router, create Device
        });
      };

      socket.on("new-producer", ({ producerId, router }) =>
        signalNewConsumerTransport(producerId, index)
      );

      const createDevice = async (rtpCapabilitiesa) => {
        try {
          device = new mediasoupClient.Device();

          await device.load({
            routerRtpCapabilities: rtpCapabilitiesa,
          });

          console.log("Device RTP Capabilities", device.rtpCapabilities);

          createSendTransport();
        } catch (error) {
          console.log(error);
          if (error.name === "UnsupportedError")
            console.warn("browser not supported");
        }
      };

      const getProducers = () => {
        socket.emit("getProducers", (producerIds) => {
          console.log(producerIds);
          // for each of the producer create a consumer
          // producerIds.forEach(id => signalNewConsumerTransport(id))
          producerIds.forEach((id) => {
            signalNewConsumerTransport(id);
          });
        });
      };

      const signalNewConsumerTransport = async (remoteProducerId, index) => {
        console.log("index", index);
        //check if we are already consuming the remoteProducerId
        if (consumingTransports.includes(remoteProducerId)) return;

        consumingTransports.push(remoteProducerId);

        console.log("signaling new users");
        await socket.emit(
          "createWebRtcTransport",
          { consumer: true, index },
          ({ params }) => {
            // The server sends back params needed
            // to create Send Transport on the client side
            if (params.error) {
              console.log(params.error);
              return;
            }
            console.log(`PARAMS... ${params}`);

            let consumerTransport;
            try {
              consumerTransport = device.createRecvTransport(params);
            } catch (error) {
              // exceptions:
              // {InvalidStateError} if not loaded
              // {TypeError} if wrong arguments.
              console.log(error);
              return;
            }

            consumerTransport.on(
              "connect",
              async ({ dtlsParameters }, callback, errback) => {
                try {
                  // Signal local DTLS parameters to the server side transport
                  // see server's socket.on('transport-recv-connect', ...)
                  socket.emit("transport-recv-connect", {
                    dtlsParameters,
                    serverConsumerTransportId: params.id,
                  });

                  // Tell the transport that parameters were transmitted.
                  callback();
                } catch (error) {
                  // Tell the transport that something was wrong
                  errback(error);
                }
              }
            );

            connectRecvTransport(
              consumerTransport,
              remoteProducerId,
              params.id
            );
          }
        );
      };

      const createSendTransport = () => {
        // see server's socket.on('createWebRtcTransport', sender?, ...)
        // this is a call from Producer, so sender = true
        socket.emit(
          "createWebRtcTransport",
          { consumer: false },
          ({ params }) => {
            // The server sends back params needed
            // to create Send Transport on the client side
            if (params.error) {
              console.log(params.error);
              return;
            }

            console.log(params);

            producerTransport = device.createSendTransport(params);

            producerTransport.on(
              "connect",
              async ({ dtlsParameters }, callback, errback) => {
                try {
                  console.log(dtlsParameters);
                  socket.emit("transport-connect", {
                    dtlsParameters,
                  });

                  // Tell the transport that parameters were transmitted.
                  callback();
                } catch (error) {
                  errback(error);
                }
              }
            );

            producerTransport.on(
              "produce",
              async (parameters, callback, errback) => {
                console.log(parameters);

                try {
                  console.log("currently producing");
                  if (
                    parameters.kind === "audio" &&
                    audioProducerCreated &&
                    parameters.kind === "video" &&
                    videoProducerCreated
                  ) {
                    console.log(`${parameters.kind} producer already exists`);

                    return;
                  }

                  socket.emit(
                    "transport-produce",
                    {
                      kind: parameters.kind,
                      rtpParameters: parameters.rtpParameters,
                      appData: parameters.appData,
                    },
                    ({ id, producersExist }) => {
                      // Tell the transport that parameters were transmitted and provide it with the
                      // server side producer's id.
                      callback({ id });

                      // if producers exist, then join room
                      if (producersExist) getProducers();
                    }
                  );
                } catch (error) {
                  errback(error);
                }
              }
            );

            connectSendTransport();
          }
        );
      };

      const connectSendTransport = async () => {
        console.log(`first video ${videoProducer}`);

        // we now call produce() to instruct the producer transport
        // to send media to the Router
        // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
        // this action will trigger the 'connect' and 'produce' events above
        if (!audioProducerCreated) {
          audioProducer = await producerTransport.produce(audioParams);
          setAudioProducerCreated(true);
          console.log(`first audio ${audioParams}`);

          // ... existing handling for audioProducer
        }

        if (!videoProducerCreated) {
          videoProducer = await producerTransport.produce(videoParams);
          console.log(`first video ${videoProducer}`);
          setVideoProducerCreated(true);
          // ... existing handling for videoProducer
        }

        audioProducer.on("trackended", () => {
          console.log("audio track ended");

          // close audio track
        });

        audioProducer.on("transportclose", () => {
          console.log("audio transport ended");

          // close audio track
        });

        videoProducer.on("trackended", () => {
          console.log("video track ended");

          // close video track
        });

        videoProducer.on("transportclose", () => {
          console.log("video transport ended");

          // close video track
        });
      };

      const connectRecvTransport = async (
        consumerTransport,
        remoteProducerId,
        serverConsumerTransportId
      ) => {
        // for consumer, we need to tell the server first
        // to create a consumer based on the rtpCapabilities and consume
        // if the router can consume, it will send back a set of params as below
        console.log("Consuming rn");

        socket.emit(
          "consume",
          {
            rtpCapabilities: device.rtpCapabilities,
            remoteProducerId,
            serverConsumerTransportId,
          },
          async ({ params }) => {
            if (params.error) {
              console.log("Cannot Consume");
              return;
            }

            console.log(`Consumer Params ${params}`);
            // then consume with the local consumer transport
            // which creates a consumer
            const consumer = await consumerTransport.consume({
              id: params.id,
              producerId: params.producerId,
              kind: params.kind,
              rtpParameters: params.rtpParameters,
            });

            consumerTransports = [
              ...consumerTransports,
              {
                consumerTransport,
                serverConsumerTransportId: params.id,
                producerId: remoteProducerId,
                consumer,
              },
            ];

            const newElem = document.createElement("div");
            newElem.setAttribute("id", `td-${remoteProducerId}`);

            if (params.kind == "audio") {
              //append to the audio container
              newElem.innerHTML =
                '<audio id="' + remoteProducerId + '" autoplay></audio>';
            } else {
              //append to the video container
              newElem.setAttribute("class", "remoteVideo");
              newElem.innerHTML =
                '<video id="' +
                remoteProducerId +
                '" autoplay class="video" ></video>';
            }

            let videoContainer = document.getElementById("videoContainer");
            videoContainer.appendChild(newElem);

            // destructure and retrieve the video track from the producer
            const { track } = consumer;

            document.getElementById(remoteProducerId).srcObject =
              new MediaStream([track]);
            // the server consumer started with media paused
            // so we need to inform the server to resume

            socket.emit("consumer-resume", {
              serverConsumerId: params.serverConsumerId,
            });
          }
        );
      };

      socket.on("producer-closed", ({ remoteProducerId }) => {
        // server notification is received when a producer is closed
        // we need to close the client-side consumer and associated transport
        const producerToClose = consumerTransports.find(
          (transportData) => transportData.producerId === remoteProducerId
        );
        producerToClose.consumerTransport.close();
        producerToClose.consumer.close();

        // remove the consumer transport from the list

        let videoContainer = document.getElementById("videoContainer");

        consumerTransports = consumerTransports.filter(
          (transportData) => transportData.producerId !== remoteProducerId
        );
        videoContainer.removeChild(
          document.getElementById(`td-${remoteProducerId}`)
        );

        // remove the video div element
      });

      socket.on("connect_error", (error) => {
        console.error("Socket connection error:", error);
      });
    }
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    console.log(peers);
    peers.forEach((stream, index) => {
      stream.getTracks().forEach((track) => {
        console.log(
          `Track - ${track.kind}: Enabled - ${track.enabled}, State - ${track.readyState}`
        );
      });
    });
  }, [peers]);

  return (
    <div id="video">
      <table class="mainTable">
        <tbody>
          <tr>
            <td class="remoteColumn">
              <div id="videoContainer"></div>
            </td>
          </tr>
        </tbody>
      </table>
      <table>
        <tbody>
          <tr>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default App;
