/**
 * CalDAV Schedule Sync Plugin for Super Productivity
 * 
 * Synchronisiert geplante Tasks zu einem CalDAV-Kalender.
 * - Tasks mit plannedAt (scheduled date) ODER
 * - Tasks mit dueWithTime (due date + time)
 * 
 * Nur Tasks ohne issueProviderId werden synchronisiert (keine importierten Tasks).
 * Änderungen an Tasks (Titel, Zeit, Beschreibung) werden automatisch synchronisiert.
 * 
 * KONFIGURATION:
 * Passe die caldavConfig unten an deine CalDAV-Server Einstellungen an.
 */

// ============================================================================
// Configuration & State
// ============================================================================

// CalDAV Konfiguration (wird aus Settings-UI geladen)
let caldavConfig = {
  username: '',
  password: '',
  calendarUrl: '',
  enabled: false
};

// Mapping: { taskId: eventUid }
let taskEventMapping = {};

// ============================================================================
// CalDAV Helper Functions
// ============================================================================

/**
 * Erstellt oder aktualisiert ein CalDAV Event für einen Task
 */
async function syncTaskToCalDAV(task) {
  if (!caldavConfig.enabled) {
    console.log('[CalDAV Sync] Plugin ist deaktiviert');
    return;
  }

  // Prüfe ob Task synchronisiert werden soll
  if (!shouldSyncTask(task)) {
    console.log('[CalDAV Sync] Task wird übersprungen:', task.id, task.title);
    return;
  }

  try {
    // WICHTIG: UID muss konsistent sein mit der UID im iCalendar Event!
    const eventUid = `sp-task-${task.id}`;
    const eventData = createEventFromTask(task);

    console.log('[CalDAV Sync] Synchronisiere Task:', task.id, task.title);
    console.log('[CalDAV Sync] Event UID:', eventUid);

    // Event zum Kalender pushen
    await putCalDAVEvent(eventUid, eventData);

    // Mapping speichern
    taskEventMapping[task.id] = eventUid;
    await saveData();
    
    console.log('[CalDAV Sync] Task erfolgreich synchronisiert:', task.id);
    console.log('[CalDAV Sync] Mapping gespeichert - Einträge:', Object.keys(taskEventMapping).length);
    
    PluginAPI.showSnack({
      msg: `"${task.title}" zum Kalender synchronisiert`,
      type: 'SUCCESS'
    });
  } catch (error) {
    console.error('[CalDAV Sync] Fehler beim Synchronisieren:', error);
    PluginAPI.showSnack({
      msg: `Fehler beim Synchronisieren: ${error.message}`,
      type: 'ERROR'
    });
  }
}

/**
 * Prüft ob ein Task synchronisiert werden soll
 */
function shouldSyncTask(task) {
  // Task muss plannedAt (scheduled) ODER dueWithTime (due + time) ODER dueDay (nur Datum) haben
  if (!task.plannedAt && !task.dueWithTime && !task.dueDay) {
    return false;
  }

  // Task darf nicht done sein
  if (task.isDone) {
    return false;
  }

  return true;
}

/**
 * Erstellt iCalendar Event-Daten aus einem Task
 */
function createEventFromTask(task) {
  // Prüfe ob Task eine Zeit hat oder nur ein Datum
  const hasTime = task.plannedAt || task.dueWithTime;
  const hasOnlyDate = !hasTime && task.dueDay;

  let dtstart, dtend;

  if (hasTime) {
    // Task hat Zeit → Zeitgebundenes Event
    const timestamp = task.plannedAt || task.dueWithTime;
    const startDate = new Date(timestamp);

    // Berechne End-Datum basierend auf timeEstimate (in ms)
    const duration = task.timeEstimate || 3600000; // Default: 1 Stunde
    const endDate = new Date(startDate.getTime() + duration);

    dtstart = `DTSTART:${formatICalDateTimeUTC(startDate)}`;
    dtend = `DTEND:${formatICalDateTimeUTC(endDate)}`;
  } else if (hasOnlyDate) {
    // Task hat nur Datum → Ganztägiges Event
    // dueDay Format: "YYYY-MM-DD"
    const dateOnly = task.dueDay.replace(/-/g, ''); // "2026-01-03" → "20260103"

    // Ganztägige Events: DTSTART;VALUE=DATE und DTEND ist nächster Tag
    dtstart = `DTSTART;VALUE=DATE:${dateOnly}`;
    dtend = `DTEND;VALUE=DATE:${dateOnly}`; // Bei ganztägigen Events ist End = Start (ein Tag)
  }

  // Erstelle iCalendar VEVENT
  const event = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Super Productivity//CalDAV Sync Plugin//DE',
    'BEGIN:VEVENT',
    `UID:sp-task-${task.id}`,
    `DTSTAMP:${formatICalDateTimeUTC(new Date())}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeICalText(task.title)}`,
    task.notes ? `DESCRIPTION:${escapeICalText(task.notes)}` : '',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(line => line).join('\r\n');

  return event;
}

/**
 * Formatiert ein Date-Objekt als iCalendar DateTime in UTC
 */
function formatICalDateTimeUTC(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Escaped iCalendar Text (Kommas, Semikolons, Backslashes)
 */
function escapeICalText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Sendet ein Event per PUT an den CalDAV Server
 */
async function putCalDAVEvent(eventUid, eventData) {
  const eventUrl = `${caldavConfig.calendarUrl}${eventUid}.ics`;
  
  console.log('[CalDAV Sync] PUT Request an:', eventUrl);
  
  const response = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Authorization': 'Basic ' + btoa(`${caldavConfig.username}:${caldavConfig.password}`)
    },
    body: eventData
  });
  
  console.log('[CalDAV Sync] PUT Response Status:', response.status, response.statusText);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[CalDAV Sync] PUT Fehler-Details:', errorText);
    throw new Error(`CalDAV PUT failed: ${response.status} ${response.statusText}`);
  }
  
  console.log('[CalDAV Sync] PUT erfolgreich');
}

/**
 * Löscht ein Event vom CalDAV Server
 */
async function deleteCalDAVEvent(eventUid) {
  console.log('[CalDAV Sync] >>> deleteCalDAVEvent() gestartet <<<');
  console.log('[CalDAV Sync] Event UID:', eventUid);
  console.log('[CalDAV Sync] Plugin enabled:', caldavConfig.enabled);

  if (!caldavConfig.enabled) {
    console.log('[CalDAV Sync] ⚠️ DELETE übersprungen - Plugin deaktiviert');
    return;
  }

  const eventUrl = `${caldavConfig.calendarUrl}${eventUid}.ics`;
  console.log('[CalDAV Sync] DELETE Request URL:', eventUrl);
  console.log('[CalDAV Sync] Username:', caldavConfig.username);
  console.log('[CalDAV Sync] Hat Password:', !!caldavConfig.password);

  try {
    console.log('[CalDAV Sync] Sende DELETE Request...');
    const response = await fetch(eventUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': 'Basic ' + btoa(`${caldavConfig.username}:${caldavConfig.password}`)
      }
    });

    console.log('[CalDAV Sync] DELETE Response Status:', response.status);
    console.log('[CalDAV Sync] DELETE Response StatusText:', response.statusText);

    const responseText = await response.text();
    console.log('[CalDAV Sync] DELETE Response Body:', responseText);

    if (!response.ok && response.status !== 404) {
      console.warn('[CalDAV Sync] ⚠️ DELETE Warnung:', response.status, response.statusText);
      // Werfe keinen Fehler, logge nur
    } else {
      console.log('[CalDAV Sync] ✅ DELETE erfolgreich oder Event existierte nicht (404)');
    }
  } catch (error) {
    console.error('[CalDAV Sync] ❌ DELETE Fehler:', error);
    throw error; // Werfe Fehler weiter für besseres Error Handling
  }
}

// ============================================================================
// Persistence
// ============================================================================
// WICHTIG: persistDataSynced() und loadSyncedData() akzeptieren KEINEN Key!
// Es gibt nur einen einzigen Persistence-Slot pro Plugin.
// Wir speichern daher Config und Mapping zusammen in einem Objekt.

/**
 * Lädt gespeicherte Daten (Config + Mapping) aus dem Plugin-Storage
 */
async function loadData() {
  try {
    console.log('[CalDAV Sync] Lade Plugin-Daten...');

    const dataString = await PluginAPI.loadSyncedData();
    console.log('[CalDAV Sync] Geladener String:', dataString);

    if (!dataString || typeof dataString !== 'string') {
      console.log('[CalDAV Sync] ⚠️ Keine gespeicherten Daten gefunden - verwende Defaults');
      return;
    }

    const data = JSON.parse(dataString);
    console.log('[CalDAV Sync] Geparste Daten:', data);

    // Lade Config
    if (data.config && typeof data.config === 'object') {
      caldavConfig = data.config;
      console.log('[CalDAV Sync] ✅ Config geladen:', {
        enabled: caldavConfig.enabled,
        hasUrl: !!caldavConfig.calendarUrl,
        hasUsername: !!caldavConfig.username,
        hasPassword: !!caldavConfig.password
      });
    }

    // Lade Mapping
    if (data.mapping && typeof data.mapping === 'object') {
      taskEventMapping = data.mapping;
      console.log('[CalDAV Sync] ✅ Mapping geladen:', Object.keys(taskEventMapping).length, 'Einträge');
    }
  } catch (error) {
    console.error('[CalDAV Sync] ❌ Fehler beim Laden:', error);
    // Bei Fehler: Defaults beibehalten
  }
}

/**
 * Speichert Config und Mapping zusammen in den Plugin-Storage
 */
async function saveData() {
  try {
    const data = {
      config: caldavConfig,
      mapping: taskEventMapping
    };

    const dataString = JSON.stringify(data);
    console.log('[CalDAV Sync] Speichere Plugin-Daten:', data);

    await PluginAPI.persistDataSynced(dataString);
    console.log('[CalDAV Sync] ✅ Daten erfolgreich gespeichert');
  } catch (error) {
    console.error('[CalDAV Sync] ❌ Fehler beim Speichern:', error);
    throw error;
  }
}

// ============================================================================
// Event Handlers
// ============================================================================


/**
 * Wird aufgerufen wenn ein Task aktualisiert wird
 */
async function onTaskUpdate(taskIdOrObject) {
  // WICHTIG: Super Productivity übergibt manchmal {taskId: 'xxx'} statt nur die ID!
  const taskId = typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;

  console.log('[CalDAV Sync] ========================================');
  console.log('[CalDAV Sync] TASK_UPDATE HOOK TRIGGERED!');
  console.log('[CalDAV Sync] Task ID:', taskId);
  console.log('[CalDAV Sync] Timestamp:', new Date().toISOString());
  console.log('[CalDAV Sync] ========================================');

  const tasks = await PluginAPI.getTasks();
  const task = tasks.find(t => t.id === taskId);

  if (task) {
    console.log('[CalDAV Sync] Task gefunden:', {
      id: task.id,
      title: task.title,
      plannedAt: task.plannedAt,
      dueWithTime: task.dueWithTime,
      dueDay: task.dueDay,
      isDone: task.isDone
    });
  }
  
  if (!task) {
    console.warn('[CalDAV Sync] Task nicht gefunden:', taskId);
    return;
  }
  
  // Prüfe ob Task synchronisiert werden soll
  if (shouldSyncTask(task)) {
    // Task ist sync-fähig → synchronisiere oder aktualisiere Event
    await syncTaskToCalDAV(task);
  } else {
    // Task ist NICHT mehr sync-fähig → lösche Event falls vorhanden
    // (z.B. wenn plannedAt/dueWithTime entfernt wurde, oder Task completed wurde)
    const eventUid = taskEventMapping[taskId] || `sp-task-${taskId}`;

    console.log('[CalDAV Sync] Task nicht mehr synchronisierbar, lösche Event:', taskId);

    try {
      await deleteCalDAVEvent(eventUid);

      // Entferne aus Mapping (falls vorhanden)
      if (taskEventMapping[taskId]) {
        delete taskEventMapping[taskId];
        await saveData();
      }

      PluginAPI.showSnack({
        msg: `Event für "${task.title}" wurde entfernt (nicht mehr geplant)`,
        type: 'SUCCESS'
      });
    } catch (error) {
      console.error('[CalDAV Sync] Fehler beim Löschen:', error);
      // Fehler nicht anzeigen, da Task evtl. nie synchronisiert wurde
    }
  }
}

/**
 * Wird aufgerufen wenn ein Task gelöscht wird
 */
async function onTaskDelete(taskIdOrObject) {
  // WICHTIG: Super Productivity übergibt manchmal {taskId: 'xxx'} statt nur die ID!
  const taskId = typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;

  console.log('[CalDAV Sync] ========================================');
  console.log('[CalDAV Sync] onTaskDelete HOOK TRIGGERED!');
  console.log('[CalDAV Sync] Task ID (extrahiert):', taskId);
  console.log('[CalDAV Sync] Original Parameter:', taskIdOrObject);
  console.log('[CalDAV Sync] Aktuelles Mapping:', taskEventMapping);
  console.log('[CalDAV Sync] ========================================');

  // Versuche UID aus Mapping zu holen, falls nicht vorhanden nutze Standard-UID
  const eventUid = taskEventMapping[taskId] || `sp-task-${taskId}`;

  console.log('[CalDAV Sync] Event UID die gelöscht werden soll:', eventUid);
  console.log('[CalDAV Sync] CalDAV enabled?', caldavConfig.enabled);

  try {
    await deleteCalDAVEvent(eventUid);

    // Entferne aus Mapping (falls vorhanden)
    if (taskEventMapping[taskId]) {
      delete taskEventMapping[taskId];
      await saveData();
    }

    console.log('[CalDAV Sync] Event erfolgreich gelöscht für Task:', taskId);

    PluginAPI.showSnack({
      msg: 'Task aus Kalender entfernt',
      type: 'SUCCESS'
    });
  } catch (error) {
    console.error('[CalDAV Sync] Fehler beim Löschen des Events:', error);
    PluginAPI.showSnack({
      msg: `Fehler beim Löschen aus Kalender: ${error.message}`,
      type: 'ERROR'
    });
  }
}

/**
 * Wird aufgerufen wenn ein Task completed wird
 */
async function onTaskComplete(taskIdOrObject) {
  // WICHTIG: Super Productivity übergibt manchmal {taskId: 'xxx'} statt nur die ID!
  const taskId = typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;

  // Optional: Event auch löschen wenn Task completed wird
  await onTaskDelete(taskId);
}

// ============================================================================
// Plugin Initialization
// ============================================================================

async function init() {
  console.log('[CalDAV Sync] Plugin wird initialisiert...');

  // Lade gespeicherte Daten (Config + Mapping)
  await loadData();
  
  // Extra Sicherheitscheck: Stelle sicher dass taskEventMapping ein Objekt ist
  if (typeof taskEventMapping !== 'object' || Array.isArray(taskEventMapping)) {
    console.warn('[CalDAV Sync] taskEventMapping ist kein valides Objekt, initialisiere neu');
    taskEventMapping = {};
  }
  
  console.log('[CalDAV Sync] Config geladen:', {
    enabled: caldavConfig.enabled,
    hasUrl: !!caldavConfig.calendarUrl,
    hasUsername: !!caldavConfig.username,
    hasPassword: !!caldavConfig.password
  });
  
  console.log('[CalDAV Sync] Task-Event-Mapping:', Object.keys(taskEventMapping).length, 'Einträge');
  
  // Registriere Event Hooks
  // WICHTIG: ANY_TASK_UPDATE statt TASK_UPDATE - triggert bei ALLEN Änderungen (inkl. Zeit)
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_UPDATE, onTaskUpdate);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_DELETE, onTaskDelete);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, onTaskComplete);
  
  // Registriere Menü-Eintrag für Settings
  PluginAPI.registerSidePanelButton({
    label: 'CalDAV Einstellungen Side Panel',
    icon: 'settings',
    onClick: () => {
      console.log('[CalDAV Sync] Settings-Menü geöffnet');
    },
    onRightClick: () => {
      console.log('[CalDAV Sync] Settings-Menü Rechtsklick geöffnet');
    }
  });

  // Registriere Sync Button
  PluginAPI.registerHeaderButton({
    label: 'CalDAV Sync',
    icon: 'cloud_upload',
    onRightClick: () => {
      console.log('[CalDAV Sync] Button Rechtsklick');
    },
    onClick: async () => {
      console.log('[CalDAV Sync] Button wurde geklickt');
      
      if (!caldavConfig.enabled) {
        PluginAPI.showSnack({
          msg: 'CalDAV Sync ist deaktiviert. Aktiviere es in den CalDAV Einstellungen (Menü)',
          type: 'ERROR'
        });
        return;
      }

      if (!caldavConfig.calendarUrl || !caldavConfig.username || !caldavConfig.password) {
        PluginAPI.showSnack({
          msg: 'CalDAV Konfiguration unvollständig! Öffne CalDAV Einstellungen im Menü',
          type: 'ERROR'
        });
        return;
      }
      
      try {
        // Manuelle Sync aller geplanten Tasks
        console.log('[CalDAV Sync] Lade Tasks...');
        const tasks = await PluginAPI.getTasks();
        console.log('[CalDAV Sync] Tasks geladen:', tasks.length);

        // Cleanup: Entferne Mappings für Tasks die nicht mehr geplant sind
        const taskIds = new Set(tasks.map(t => t.id));
        const scheduledTaskIds = new Set(tasks.filter(shouldSyncTask).map(t => t.id));

        let cleanedUp = 0;
        for (const taskId in taskEventMapping) {
          // Wenn Task noch existiert aber nicht mehr geplant ist, räume auf
          if (taskIds.has(taskId) && !scheduledTaskIds.has(taskId)) {
            console.log('[CalDAV Sync] Cleanup: Task nicht mehr geplant, lösche Event:', taskId);
            try {
              await deleteCalDAVEvent(taskEventMapping[taskId]);
              delete taskEventMapping[taskId];
              cleanedUp++;
            } catch (error) {
              console.error('[CalDAV Sync] Fehler beim Cleanup:', error);
            }
          }
        }

        if (cleanedUp > 0) {
          await saveData();
          console.log(`[CalDAV Sync] ✅ ${cleanedUp} ungeplante(s) Event(s) aufgeräumt`);
        }

        const tasksToSync = tasks.filter(shouldSyncTask);
        console.log('[CalDAV Sync] Tasks zum Synchronisieren:', tasksToSync.length);
        
        if (tasksToSync.length === 0) {
          PluginAPI.showSnack({
            msg: 'Keine geplanten Tasks zum Synchronisieren gefunden',
            type: 'SUCCESS'
          });
          return;
        }
        
        let syncedCount = 0;
        let errorCount = 0;

        for (const task of tasksToSync) {
          try {
            await syncTaskToCalDAV(task);
            syncedCount++;

            // Rate-Limiting: 300ms Verzögerung zwischen Requests (verhindert HTTP 429)
            if (syncedCount < tasksToSync.length) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch (error) {
            console.error('[CalDAV Sync] Fehler beim Synchronisieren von Task:', task.id, error);
            errorCount++;
          }
        }
        
        PluginAPI.showSnack({
          msg: `${syncedCount} Tasks synchronisiert, ${errorCount} Fehler`,
          type: errorCount === 0 ? 'SUCCESS' : 'ERROR'
        });
      } catch (error) {
        console.error('[CalDAV Sync] Fehler:', error);
        PluginAPI.showSnack({
          msg: `Fehler beim Synchronisieren: ${error.message}`,
          type: 'ERROR'
        });
      }
    }
  });
  
  console.log('[CalDAV Sync] Plugin erfolgreich initialisiert');

  // Listener für postMessage vom Settings-iframe
  window.addEventListener('message', async (event) => {
    console.log('[CalDAV Sync] postMessage empfangen:', event.data);

    if (!event.data || event.data.pluginId !== 'caldav-sync') {
      console.log('[CalDAV Sync] Ignoriere Message (nicht für dieses Plugin)');
      return;
    }

    if (event.data.type === 'REQUEST_CONFIG') {
      console.log('[CalDAV Sync] ✅ Config-Anfrage vom iframe erhalten, sende Config...');

      // Sende Config zurück an iframe
      event.source.postMessage({
        type: 'CONFIG_RESPONSE',
        config: caldavConfig
      }, '*');
    }

    if (event.data.type === 'SAVE_CONFIG') {
      console.log('[CalDAV Sync] ✅ Config-Speicher-Anfrage vom iframe erhalten!');
      console.log('[CalDAV Sync] Neue Config:', event.data.config);

      try {
        // Update lokale Config
        caldavConfig = event.data.config;

        // Speichere Config UND Mapping zusammen
        await saveData();

        console.log('[CalDAV Sync] Config erfolgreich gespeichert');

        // Sende Bestätigung zurück
        event.source.postMessage({
          type: 'CONFIG_SAVED',
          success: true
        }, '*');

        // Zeige Snackbar
        PluginAPI.showSnack({
          msg: 'CalDAV Einstellungen gespeichert',
          type: 'SUCCESS'
        });
      } catch (error) {
        console.error('[CalDAV Sync] Fehler beim Speichern der Config:', error);

        // Sende Fehler zurück
        event.source.postMessage({
          type: 'CONFIG_SAVED',
          success: false,
          error: error.message
        }, '*');
      }
    }
  });

  // Zeige Status-Nachricht
  if (caldavConfig.enabled) {
    PluginAPI.showSnack({
      msg: 'CalDAV Sync aktiviert',
      type: 'SUCCESS'
    });
  }
}

// Starte Plugin
init();

// ============================================================================
// Debug Helper Functions (verfügbar in Browser Console)
// ============================================================================

/**
 * Debug-Funktion: Zeigt aktuelles Task-Event-Mapping
 * Aufruf in Console: window.CalDAVSync.showMapping()
 */
window.CalDAVSync = {
  showData: async () => {
    console.log('=== CalDAV Config (Current) ===');
    console.log({
      enabled: caldavConfig.enabled,
      username: caldavConfig.username,
      calendarUrl: caldavConfig.calendarUrl,
      hasPassword: !!caldavConfig.password
    });

    console.log('\n=== CalDAV Mapping (Current) ===');
    console.table(taskEventMapping);
    console.log('Anzahl Einträge:', Object.keys(taskEventMapping).length);

    // Zeige gespeicherte Version
    const dataString = await PluginAPI.loadSyncedData();
    console.log('\n=== Gespeicherte Daten (Raw) ===');
    console.log(dataString);

    if (dataString) {
      const data = JSON.parse(dataString);
      console.log('\n=== Gespeicherte Daten (Parsed) ===');
      console.log('Config:', data.config);
      console.log('Mapping:', data.mapping);
    }

    return {
      current: { config: caldavConfig, mapping: taskEventMapping },
      saved: dataString ? JSON.parse(dataString) : null
    };
  },

  showConfig: () => {
    console.log('=== CalDAV Config ===');
    console.log({
      enabled: caldavConfig.enabled,
      username: caldavConfig.username,
      calendarUrl: caldavConfig.calendarUrl,
      hasPassword: !!caldavConfig.password
    });
    return caldavConfig;
  },

  syncTask: async (taskId) => {
    const tasks = await PluginAPI.getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error('Task nicht gefunden:', taskId);
      return;
    }
    console.log('Synchronisiere Task:', task);
    await syncTaskToCalDAV(task);
  },

  deleteEvent: async (taskId) => {
    const eventUid = taskEventMapping[taskId];
    if (!eventUid) {
      console.error('Keine Event UID für Task:', taskId);
      return;
    }
    console.log('Lösche Event:', eventUid);
    await deleteCalDAVEvent(eventUid);
    delete taskEventMapping[taskId];
    await saveData();
    console.log('Event gelöscht und Mapping aktualisiert');
  },

  resetMapping: async () => {
    if (confirm('Wirklich das komplette Task-Event-Mapping zurücksetzen?')) {
      taskEventMapping = {};
      await saveData();
      console.log('Mapping zurückgesetzt');
    }
  },

  resetAll: async () => {
    if (confirm('Wirklich ALLE Daten (Config + Mapping) zurücksetzen?')) {
      caldavConfig = {
        username: '',
        password: '',
        calendarUrl: '',
        enabled: false
      };
      taskEventMapping = {};
      await saveData();
      console.log('Alle Daten zurückgesetzt');
    }
  },

  cleanupOrphanedMappings: async () => {
    console.log('[CalDAV Sync] Prüfe auf verwaiste Mappings...');
    const tasks = await PluginAPI.getTasks();
    const taskIds = new Set(tasks.map(t => t.id));

    let removedCount = 0;
    for (const taskId in taskEventMapping) {
      if (!taskIds.has(taskId)) {
        console.log('[CalDAV Sync] Entferne verwaistes Mapping für gelöschten Task:', taskId);
        delete taskEventMapping[taskId];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      await saveData();
      console.log(`[CalDAV Sync] ✅ ${removedCount} verwaiste(s) Mapping(s) entfernt`);
    } else {
      console.log('[CalDAV Sync] Keine verwaisten Mappings gefunden');
    }

    return removedCount;
  },

  forceRemoveMapping: async (taskId) => {
    if (taskEventMapping[taskId]) {
      console.log('[CalDAV Sync] Entferne Mapping für Task:', taskId);
      delete taskEventMapping[taskId];
      await saveData();
      console.log('[CalDAV Sync] ✅ Mapping entfernt');
      return true;
    } else {
      console.log('[CalDAV Sync] Kein Mapping für Task gefunden:', taskId);
      return false;
    }
  },

  getTaskDetails: async (taskId) => {
    const tasks = await PluginAPI.getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error('[CalDAV Sync] Task nicht gefunden:', taskId);
      return null;
    }

    console.log('=== Task Details ===');
    console.log('ID:', task.id);
    console.log('Title:', task.title);
    console.log('isDone:', task.isDone);
    console.log('plannedAt:', task.plannedAt);
    console.log('dueWithTime:', task.dueWithTime);
    console.log('dueDay:', task.dueDay);
    console.log('issueProviderId:', task.issueProviderId);
    console.log('shouldSyncTask:', shouldSyncTask(task));
    console.log('\n=== Full Task Object ===');
    console.log(task);

    return task;
  }
};

console.log('[CalDAV Sync] Debug-Funktionen verfügbar unter window.CalDAVSync');
console.log('Beispiele:');
console.log('  window.CalDAVSync.showData()                     - Zeigt alle Daten (Config + Mapping)');
console.log('  window.CalDAVSync.showConfig()                   - Zeigt Config');
console.log('  window.CalDAVSync.getTaskDetails(taskId)         - Zeigt Details zu einem Task');
console.log('  window.CalDAVSync.cleanupOrphanedMappings()      - Entfernt verwaiste Mappings');
console.log('  window.CalDAVSync.forceRemoveMapping(taskId)     - Entfernt Mapping für spezifischen Task');
console.log('  window.CalDAVSync.resetMapping()                 - Mapping zurücksetzen');
console.log('  window.CalDAVSync.resetAll()                     - Alle Daten zurücksetzen');

