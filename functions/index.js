/* eslint-disable linebreak-style */
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
const auth = require("firebase-admin/auth");

admin.initializeApp();
const db = admin.firestore();

// encounter handler helper functions
const sendMessageToPlayer = async (playerId, payload) => {
    logger.log("[sendMessageToPlayer] Starting with payload:", payload);
    // const userDoc = await db.collection("Users").doc(userId).get();
    const userDoc = await auth.getAuth().getUser(playerId)
        .then((userRecord) => {
            logger.log("[sendMessageToPlayer] got user:", userRecord);
        })
        .catch((error) => {
            logger.error("[sendMessageToPlayer] Error fetching user document:", error);
            throw new Error("User not found");
        });
    logger.log("[sendMessageToPlayer] Found user document:", userDoc);
    const userData = userDoc.data();
    const fcmToken = userData && userData.fcmToken;

    if (fcmToken) {
        logger.log("[sendMessageToPlayer] Sending FCM message to token:", fcmToken);
        // await admin.messaging().send({
        //     token: fcmToken,
        //     notification: {
        //         title: "New Message",
        //         body: message,
        //     },
        // });
    } else {
        logger.warn("[sendMessageToPlayer] No FCM token found for user:", playerId);
    }
};

const monitorLocation = async (payload) => {
    logger.log("[monitorLocation] Starting with payload:", payload);
    const { userId, geofence } = payload;
    const geofenceDoc = await db.collection("activeGeofences").add({
        userId,
        ...geofence,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.log("[monitorLocation] Created geofence document:", geofenceDoc.id);
};

const sendNotificationToPlayer = async (playerId, payload) => {
    logger.log("[sendNotificationToPlayer] Starting with payload:", payload);
    const { userId, notification } = payload;

    const userDoc = await db.collection("users").doc(userId).get();
    logger.log("[sendNotificationToPlayer] Found user document:", userDoc.exists);
    const userData = userDoc.data();
    const fcmToken = userData && userData.fcmToken;

    if (fcmToken) {
        logger.log("[sendNotificationToPlayer] Sending notification to token:", fcmToken);
        await admin.messaging().send({
            token: fcmToken,
            notification: {
                title: notification.title,
                body: notification.body,
            },
        });
    } else {
        logger.warn("[sendNotificationToPlayer] No FCM token found for user:", userId);
    }
};

const sendNotificationToHosts = async (payload) => {
    logger.log("[sendNotificationToHosts] Starting with payload:", payload);
    const { experienceId, notification } = payload;

    const expDoc = await db
        .collection("ExperienceCalendar")
        .doc(experienceId)
        .get();
    logger.log("[sendNotificationToHosts] Found experience document:", expDoc.exists);
    const expData = expDoc.data();
    const hosts = expData ? expData.hosts || [] : [];
    logger.log("[sendNotificationToHosts] Found hosts:", hosts.length);

    const notifications = hosts.map(async (hostId) => {
        const hostDoc = await db.collection("users").doc(hostId).get();
        logger.log("[sendNotificationToHosts] Processing host:", hostId, "exists:", hostDoc.exists);
        const hostData = hostDoc.data();
        const fcmToken = hostData && hostData.fcmToken;

        if (fcmToken) {
            logger.log("[sendNotificationToHosts] Sending notification to host:", hostId);
            await admin.messaging().send({
                token: fcmToken,
                notification: {
                    title: notification.title,
                    body: notification.body,
                },
            });
        } else {
            logger.warn("[sendNotificationToHosts] No FCM token found for host:", hostId);
        }
    });

    await Promise.all(notifications);
    logger.log("[sendNotificationToHosts] Completed sending notifications to all hosts");
};

// Internal functions
const runExperience = async (scheduledExperienceId, auth) => {
    // runExperience should get the scheduledExperience doc with the PlayerUser ID, isActive bool, and id for the original experience
    // then get the original experience doc, and initialize the encounters queue
    // encountersQueue array should maybe be added to the scheduledExperience doc
    // should then call triggerEncounter on the first encounter in the queue, passing in the encounter data json, and player and host IDs
    logger.log("[runExperience] Starting experience with scheduledExperienceId:", scheduledExperienceId, "auth:", auth);

    try {
        const expRef = db.collection("ExperienceCalendar").doc(scheduledExperienceId);
        const expDoc = await expRef.get();
        const scheduledExperience = expDoc.data();

        if (!scheduledExperience) {
            logger.warn("[runExperience] Experience not found:", scheduledExperienceId);
            throw new Error("Experience not found");
        }
        logger.log("[runExperience] scheduled experience data:", scheduledExperience);
        if (scheduledExperience.isActive) {
            logger.log("[runExperience] Initializing queue for active experience");
            const originalExperience = db.collection("ImmersiveExperiences").doc(scheduledExperience.experienceId);
            const originalExperienceData = await originalExperience.get();
            const expData = originalExperienceData.data();
            const encountersQueue = expData ? expData.encounters || [] : [];
            logger.log("[runExperience] Found encounters:", encountersQueue.length);

            if (encountersQueue.length > 0) {
                const firstEncounter = encountersQueue[0];
                logger.log("[runExperience] Triggering first encounter:", firstEncounter.id);
                const users = scheduledExperience.users || []; // TODO: Implement playerUser(s), and hosts. Hosts should be associated with individual encounters
                users.push(scheduledExperience.playerUser);
                await triggerEncounter(firstEncounter, auth, users);

                logger.log("[runExperience] Updating experience status");
                await expRef.update({
                    encountersQueue: encountersQueue,
                    current_encounter_id: firstEncounter.id,
                });
                logger.log("[runExperience] Experience status updated successfully");
            }
        } else {
            logger.log("[runExperience] Experience not active or queue already initialized");
        }

        logger.log("[runExperience] Successfully completed");
        return { success: true };
    } catch (error) {
        logger.error("[runExperience] Error:", error);
        throw error;
    }
};

const triggerEncounter = async (encounter, auth, users, activeExperience = true) => {
    // trigger needs:
    // - player + host ids to send messages/notifications to
    // - encounter data (type, summary, etc.)
    // - any message/notification payload to send
    // - active/inactive bool to cancel encounter if experience is inactive. Pass as arg, or check in runExperience?
    logger.log("[triggerEncounter] Starting with type:", encounter.type, "auth:", auth);
    logger.log("[triggerEncounter] encounter: ", encounter);

    try {
        if (!activeExperience) {
            logger.warn("[triggerEncounter] Attempted to trigger encounter for inactive experience:");
            throw new Error("Cannot trigger encounter for inactive experience");
        }
        const playerId = users[0]; // placeholder until hosts + players are implemented
        const payload = encounter.summary; // TODO: message/text field specific to message encounter types
        logger.log("[triggerEncounter] Experience is active, proceeding with encounter");
        switch (encounter.type) {
            case "message":
                await sendMessageToPlayer(playerId, payload);
                break;
            case "geofenced_encounter":
                await monitorLocation();
                break;
            case "planned_encounter":
                await sendNotificationToPlayer(playerId, payload);
                await sendNotificationToHosts(payload);
                break;
            case "surprise_encounter":
                await sendNotificationToHosts(payload);
                break;
            case "item_encounter":
                await sendNotificationToPlayer(playerId, payload);
                break;
            default:
                logger.warn("[triggerEncounter] Unknown encounter type:", payload.type);
        }
        return { success: true };
    } catch (error) {
        logger.error("[triggerEncounter] Error:", error);
        throw error;
    }
};

const endExperience = async (docRefString, auth) => {
    logger.log("[endExperience] Starting with docRef:", docRefString, "auth:", auth);

    try {
        const docRef = db.doc(docRefString);
        const docSnapshot = await docRef.get();

        if (!docSnapshot.exists) {
            logger.warn("[endExperience] Document not found:", docRefString);
            throw new Error(`Document at reference ${docRefString} does not exist.`);
        }

        await docRef.update({ isActive: false });
        logger.log("[endExperience] Successfully ended experience");
        return { message: `Document ${docRefString} updated successfully.` };
    } catch (error) {
        logger.error("[endExperience] Error:", error);
        throw error;
    }
};

// HTTP Callable wrappers
exports.runExperienceHttp = onCall(async (data, context) => {
    if (!context.auth) {
        throw new v2.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated."
        );
    }

    const { experienceId } = data;
    if (!experienceId) {
        throw new v2.https.HttpsError(
            "invalid-argument",
            "Experience ID is required."
        );
    }

    try {
        const result = await runExperience(experienceId, context.auth);
        return result;
    } catch (error) {
        throw new v2.https.HttpsError(
            "internal",
            "An error occurred while starting the experience.",
            error.message
        );
    }
});

exports.triggerEncounterHttp = onCall(async (data, context) => {
    if (!context.auth) {
        throw new v2.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated."
        );
    }

    const { type, payload, experienceId } = data;
    if (!type || !payload || !experienceId) {
        throw new v2.https.HttpsError(
            "invalid-argument",
            "Encounter type, payload, and experienceId are required."
        );
    }

    try {
        const result = await triggerEncounter(type, payload, context.auth, experienceId);
        return result;
    } catch (error) {
        if (error.message === "Experience not found") {
            throw new v2.https.HttpsError("not-found", "Experience not found");
        } else if (error.message === "Cannot trigger encounter for inactive experience") {
            throw new v2.https.HttpsError("failed-precondition", "Cannot trigger encounter for inactive experience");
        }
        throw new v2.https.HttpsError(
            "internal",
            "Failed to process encounter.",
            error.message
        );
    }
});

exports.endExperienceHttp = onCall(async (data, context) => {
    if (!context.auth) {
        throw new v2.https.HttpsError(
            "unauthenticated",
            "The function must be called while authenticated."
        );
    }

    const { docRefString } = data;
    if (!docRefString) {
        throw new v2.https.HttpsError(
            "invalid-argument",
            "Document reference string is required."
        );
    }

    try {
        const result = await endExperience(docRefString, context.auth);
        return result;
    } catch (error) {
        throw new v2.https.HttpsError(
            "internal",
            "An error occurred while ending the experience.",
            error.message
        );
    }
});

exports.startActiveExperiences = onSchedule("* * * * *", async () => {
    logger.log("Checking for scheduled experiences to start.");
    const now = admin.firestore.Timestamp.fromDate(new Date());

    try {
        const twoMinutesAgo = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 2 * 60 * 1000));
        const snapshot = await db.collection("ExperienceCalendar")
            .where("startDateTime", ">=", twoMinutesAgo)
            .where("startDateTime", "<=", now)
            .where("isActive", "==", true)
            .get();

        if (snapshot.empty) {
            logger.log("No experiences to start at this time.");
            return null;
        }
        const systemAuth = { uid: "system" };

        for (const doc of snapshot.docs) {
            // Use internal runExperience function
            await runExperience(doc.id, systemAuth);
        }
        logger.log("Started experiences successfully.");
    } catch (error) {
        logger.error("Error starting experiences:", error);
    }

    return null;
});

// Update checkForScheduledExperiences to use internal function
exports.checkForScheduledExperiences = onSchedule("* * * * *", async () => {
    logger.log("Checking for scheduled experiences every minute and marking active.");
    const now = admin.firestore.Timestamp.fromDate(new Date());

    try {
        const snapshot = await db.collection("ExperienceCalendar")
            .where("startDateTime", "<=", now) // TODO: fix so we don't reactivate old experiences- set to within the last 1-2 minutes
            .where("isActive", "==", false)
            .get();

        if (snapshot.empty) {
            logger.log("No experiences to activate at this time.");
            return null;
        }

        const batch = db.batch();

        for (const doc of snapshot.docs) {
            const scheduledExperience = doc.ref;
            batch.update(scheduledExperience, { isActive: true });
            logger.log(`Marked experience ${doc.id} as active.`);
        }

        await batch.commit();
        logger.log("Experiences successfully marked as active.");
    } catch (error) {
        logger.error("Error marking experiences active:", error);
    }

    return null;
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
