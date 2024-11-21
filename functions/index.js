const v2 = require("firebase-functions/v2");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/scheduler");
const { onCall } = require("firebase-functions/https");
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

exports.helloworld_2 = v2.https.onRequest((request, response) => {
    // will print a link to run the function in the emulator logs
    debugger;
    const name = request.params[0].replace("/", "");
    const items = { lamp: "this is lamp", chair: "good chair" };  // for a valid request, append either lamp or chair
    const message = items[name];
    console.log('weeeeeeeeeeeeeeeeeeeeeeeeeeee')
    response.send(`<h1>${message}</h1>`);
});

exports.scheduleExperience = v2.https.onRequest(async (req, res) => {
    // Allow only POST requests
    if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
    }

    try {
        // Parse data from the request body
        const { collectionName, documentData } = req.body;

        // Check if required fields are provided
        if (!collectionName || !documentData) {
            return res.status(400).send("Invalid request: collectionName and documentData are required.");
        }

        // Add the document to the specified Firestore collection
        const expRef = await db.collection("ImmersiveExperiences").doc("5weqGOnb2Kv3DfGFlnEX")
        const expData = {
            "experienceRef": expRef,
            "eventsQueue": [],
            "hosts": [],
            "isActive": false,
            "startDateTime": new Date('2024-11-18T15:00:00Z'),
            "players": []
        }

        const docRef = await db.collection(collectionName).add(expData);

        // Send success response
        console.log(docRef.path)
        res.status(200).send(`Document added with ID: ${docRef.id}`);
    } catch (error) {
        console.error("Error adding document:", error);
        res.status(500).send("Error adding document: " + error.message);
    }
});

exports.checkForScheduledExperiences = v2.https.onRequest(async (request, response) => { // onSchedule("* * * * *", async (event) => {
    console.log("checking for experiences every minute ")
    console.log('request: ', request)
    console.log('response: ', response)
    const now = new Date()
    console.log(now)
    try {
        // Query experiences that are scheduled to start now or earlier but are not active
        const snapshot = await db.collection('ExperienceCalendar')
            .where('startDateTime', '<=', now)
            .where('isActive', '==', false)
            .get();

        if (snapshot.empty) {
            console.log('No experiences to start at this time.');
            response.status(200).send('No experiences to start at this time.');
        }

        const batch = db.batch();

        // Iterate through the experiences and mark them as active
        snapshot.docs.forEach(doc => {
            const scheduledExperience = db.collection('ExperienceCalendar').doc(doc.id);
            // TODO: Either call startExperience directly, or batch-mark experiences as active and call startExperience onUpdate of doc
            batch.update(scheduledExperience, { isActive: true });
            debugger;
            // startExperience(doc.data().experienceRef)  // this.startExperience()?

            // Optional: Trigger additional logic to initialize the experience
            // console.log(`Starting experience: ${doc.data().name}`);
        });

        // Commit the batch update
        await batch.commit();
        console.log('Experiences successfully started.');
        response.status(200).send('Experiences successfully started.');

    } catch (error) {
        console.error('Error starting experiences:', error);
        response.status(500).send(error);
    }
    return null;
});

// exports.startExperience = functions.firestore
//     .document('ExperienceCalendar/{experienceId}')
//     .onUpdate(async (change, context) => {...})
exports.startExperience = onCall(async (change, context) => {
    const experience = change.after.data();
    if (experience.is_active && !experience.queue_initialized) {
        const experienceId = context.params.experienceId;

        // Fetch and initialize event queue
        const eventsSnapshot = await db.collection('Events') // TODO: events come from events array on experience ref, not their own collection
            .where('experience_id', '==', experienceId)
            .orderBy('sequence_number')
            .get();

        const eventsQueue = eventsSnapshot.docs.map(doc => doc.data());

        // Trigger the first event
        if (eventsQueue.length > 0) {
            const firstEvent = eventsQueue[0];
            await triggerEvent(firstEvent);
            await db.collection('ExperienceCalendar').doc(experienceId).update({
                queue_initialized: true,
                current_event_id: firstEvent.id
            });
        }
    }
});

// exports.triggerEvent = onCall(async (event) => {...})
exports.triggerEvent = onCall(async (event) => {
    switch (event.type) {
        case 'message':
            await sendMessageToPlayer(event.payload);
            break;
        case 'geofenced_encounter':
            await monitorLocation(event.payload);
            break;
        case 'planned_encounter':
            await sendNotificationToPlayer(event.payload);
            await sendNotificationToHosts(event.payload);
            break;
        case 'surprise_encounter':
            await sendNotificationToHosts(event.payload);
            break;
        case 'item_encounter':  //TODO: item encounters could just be geofenced encounters with an optional delay on triggering the next event
            await sendNotificationToPlayer(event.payload);
            break;
        default:
            console.log('Unknown event type');
    }
})

// exports.startExperience = onCall((experience) => {
//     // for each experience, initialize a queue for events/encounters?
// })


// exports.startEvent = onCall((experience) => {
//     // send notification to all hosts
//     // send any provided message(s) to player
// })