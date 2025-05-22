/* eslint-disable indent */
/* eslint-disable require-jsdoc */
/* eslint-disable no-unused-vars */
/* eslint-disable comma-dangle */
/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
const v2 = require("firebase-functions/v2");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { onCall } = require("firebase-functions/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Helper functions for Firebase Cloud Messaging and encounter handling
const sendMessageToPlayer = async (payload) => {
    const { userId, message } = payload;
    const userDoc = await db.collection("users").doc(userId).get();
    const fcmToken = userDoc.data().fcmToken;

    if (fcmToken) {
        await admin.messaging().send({
            token: fcmToken,
            notification: {
                title: "New Message",
                body: message,
            },
        });
    }
    return;
};

const sendNotificationToPlayer = async (payload) => {
    const { userId, notification } = payload;
    const userDoc = await db.collection("users").doc(userId).get();
    const fcmToken = userDoc.data().fcmToken;

    if (fcmToken) {
        await admin.messaging().send({
            token: fcmToken,
            notification: {
                title: notification.title,
                body: notification.body,
            },
        });
    }
    return;
};

const sendNotificationToHosts = async (payload) => {
    const { experienceId, notification } = payload;
    const expDoc = await db.collection("ExperienceCalendar").doc(experienceId).get();
    const hosts = expDoc.data().hosts || [];

    const notifications = hosts.map(async (hostId) => {
        const hostDoc = await db.collection("users").doc(hostId).get();
        const fcmToken = hostDoc.data().fcmToken;

        if (fcmToken) {
            await admin.messaging().send({
                token: fcmToken,
                notification: {
                    title: notification.title,
                    body: notification.body,
                },
            });
        }
    });

    await Promise.all(notifications);
    return;
};

const monitorLocation = async (payload) => {
    const { userId, geofence } = payload;
    await db.collection("activeGeofences").add({
        userId,
        ...geofence,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
};

// Main functions
exports.checkForScheduledExperiences = onSchedule("* * * * *", async (encounter) => {
    logger.log("Checking for scheduled experiences every minute.");
    const now = admin.firestore.Timestamp.fromDate(new Date()); // Convert to Firestore Timestamp

    try {
        const snapshot = await db.collection("ExperienceCalendar")
            .where("startDateTime", "<=", now) // TODO: where startDateTime is within the last 1-2 minutes. Don't want to re-activate old experiences...
            .where("isActive", "==", false)
            .get();

        if (snapshot.empty) {
            logger.log("No experiences to start at this time.");
            return null; // Exit the function early
        }

        const batch = db.batch();

        snapshot.docs.forEach((doc) => {
            const scheduledExperience = doc.ref; // Use doc.ref directly
            batch.update(scheduledExperience, { isActive: true });
            logger.log(`Marked experience ${doc.id} as active.`);
            this.startExperience(doc.id);
            // TODO - call startExperience(scheduledExperience)
            // form queue of experiences to start?
        });

        await batch.commit(); // Commit all updates
        logger.log("Experiences successfully marked as active.");
    } catch (error) {
        logger.error("Error marking experiences active:", error);
    }

    return null; // Function must return a value
});

exports.startExperience = onCall(async (data, context) => {
    if (!context.auth) {
        throw new v2.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated.",
        );
    }

    const { experienceId } = data;
    if (!experienceId) {
        throw new v2.https.HttpsError(
            "invalid-argument",
            "Experience ID is required.",
        );
    }

    try {
        const expRef = db.collection("ExperienceCalendar").doc(experienceId);
        const expDoc = await expRef.get();
        const experience = expDoc.data();

        if (!experience) {
            throw new v2.https.HttpsError("not-found", "Experience not found.");
        }

        if (experience.isActive && !experience.queue_initialized) {
            const experienceRef = experience.experienceRef;
            const experienceData = await experienceRef.get();
            const encounters = experienceData.data().encounters || [];

            if (encounters.length > 0) {
                const firstEncounter = encounters[0];
                await exports.triggerEncounter({
                    data: {
                        type: firstEncounter.type,
                        payload: firstEncounter.payload,
                    },
                });

                await expRef.update({
                    queue_initialized: true,
                    current_encounter_id: firstEncounter.id,
                });
            }
        }

        return { success: true };
    } catch (error) {
        logger.error("Error in startExperience:", error);
        throw new v2.https.HttpsError(
            "internal",
            "An error occurred while starting the experience.",
        );
    }
});

exports.triggerEncounter = onCall(async (data, context) => {
    if (!context.auth) {
        throw new v2.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated.",
        );
    }

    const encounter = data;
    switch (encounter.type) {
        case "message":
            await sendMessageToPlayer(encounter.payload);
            break;
        case "geofenced_encounter":
            await monitorLocation(encounter.payload);
            break;
        case "planned_encounter":
            await sendNotificationToPlayer(encounter.payload);
            await sendNotificationToHosts(encounter.payload);
            break;
        case "surprise_encounter":
            await sendNotificationToHosts(encounter.payload);
            break;
        case "item_encounter":
            await sendNotificationToPlayer(encounter.payload);
            break;
        default:
            logger.log("Unknown encounter type");
    }
    return { success: true };
});

exports.endExperience = onCall(async (data, context) => {
    // Check if the user is authenticated
    if (!context.auth) {
        throw new v2.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated."
        );
    }

    // Get the document reference string from the request
    const docRefString = data.docRefString;
    if (!docRefString) {
        throw new v2.https.HttpsError(
            "invalid-argument",
            "Document reference string is required."
        );
    }

    try {
        // Get the document reference
        const docRef = db.doc(docRefString);

        // Check if the document exists
        const docSnapshot = await docRef.get();
        if (!docSnapshot.exists) {
            throw new v2.https.HttpsError(
                "not-found",
                `Document at reference ${docRefString} does not exist.`
            );
        }

        // Update the isActive field to false
        await docRef.update({ isActive: false });

        return { message: `Document ${docRefString} updated successfully.` };
    } catch (error) {
        logger.error("Error updating document: ", error);
        throw new v2.https.HttpsError(
            "unknown",
            "An error occurred while updating the document.",
            error.message
        );
    }
});

exports.queryUserLocation = onCall(async (change, context) => {
    const { latitude: userLat, longitude: userLng } = change.after.data();

    // Retrieve destination from Firestore
    const destinationDoc = await admin.firestore()
        .collection("locations")
        .doc("destinationId")
        .get();

    const { latitude: destLat, longitude: destLng } = destinationDoc.data();

    const distance = haversineDistance(userLat, userLng, destLat, destLng);

    // Check if within the arrival radius (e.g., 50 meters)
    const arrivalRadius = 0.05; // in kilometers
    if (distance <= arrivalRadius) {
        logger.log("User has arrived at the destination");
        // Update user status or notify
        await admin.firestore()
            .collection("users")
            .doc(context.params.userId)
            .update({ hasArrived: true });
    }
});

function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (value) => (value * Math.PI) / 180;
    const R = 6371; // Earth's radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}


// exports.startExperience = onCall((experience) => {
//     // for each experience, initialize a queue for encounters/encounters?
// })


// exports.startEncounter = onCall((experience) => {
//     // send notification to all hosts
//     // send any provided message(s) to player
// })

// exports.helloworld_2 = v2.https.onRequest((request, response) => {
//     // will print a link to run the function in the emulator logs
//     debugger;
//     const name = request.params[0].replace("/", "");
//     const items = { lamp: "this is lamp", chair: "good chair" };  // for a valid request, append either lamp or chair
//     const message = items[name];
//     logger.log('weeeeeeeeeeeeeeeeeeeeeeeeeeee')
//     response.send(`<h1>${message}</h1>`);
// });

// exports.scheduleExperience = v2.https.onRequest(async (req, res) => {
//     if (req.method !== "POST") {
//         return res.status(405).send("Method Not Allowed");
//     }

//     try {
//         const { collectionName, documentData } = req.body;

//         if (!collectionName || !documentData) {
//             return res.status(400).send("Invalid request: collectionName and documentData are required.");
//         }

//         const expRef = await db.collection("ImmersiveExperiences").doc("5weqGOnb2Kv3DfGFlnEX");
//         const expData = {
//             "experienceRef": expRef,
//             "encountersQueue": [],
//             "hosts": [],
//             "isActive": false,
//             "startDateTime": new Date("2024-11-18T15:00:00Z"),
//             "players": []
//         };

//         const docRef = await db.collection(collectionName).add(expData);

//         logger.log(docRef.path);
//         res.status(200).send(`Document added with ID: ${docRef.id}`);
//     } catch (error) {
//         logger.error("Error adding document:", error);
//         res.status(500).send("Error adding document: " + error.message);
//     }
// });
