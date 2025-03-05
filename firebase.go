package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	firebase "firebase.google.com/go"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const maxShareSize = 10 * 1024 // 10kB max size of the JSON blob (might need to be increased in the future)

var (
	firebaseStarted sync.Once
	firestoreClient *firestore.Client
)

func initFirebase() {
	firebaseStarted.Do(func() {
		ctx := context.Background()
		var app *firebase.App
		var err error
		if firebaseCredentials != "" {
			// running locally
			sa := option.WithCredentialsFile(firebaseCredentials)
			cfg := &firebase.Config{}
			app, err = firebase.NewApp(ctx, cfg, sa)
		} else {
			// running on Google Cloud
			app, err = firebase.NewApp(ctx, nil)
		}
		if err != nil {
			log.Fatalln(err)
		}

		firestoreClient, err = app.Firestore(ctx)
		if err != nil {
			log.Fatalln(err)
		}
	})
}

func handleShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "GET" {
		id := r.FormValue("id")
		if id == "" {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte("no ID supplied"))
			return
		}

		initFirebase()
		ctx := context.Background()

		doc, err := firestoreClient.Collection("shared").Doc(id).Get(ctx)
		if status.Code(err) == codes.NotFound {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte("ID not found"))
			return
		}
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte("could not fetch shared data"))
			fmt.Fprintln(os.Stderr, "could not fetch data:", err)
			return
		}
		data, err := json.Marshal(map[string]any{
			"data": doc.Data()["data"],
		})
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte("could not serialize shared data"))
			fmt.Fprintln(os.Stderr, "could not serialize data:", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	} else if r.Method == "POST" {
		if r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			w.Write([]byte("expected application/json data"))
			return
		}

		// Read the data from the POST request.
		var data any
		err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxShareSize)).Decode(&data)
		if err != nil {
			w.WriteHeader(http.StatusUnprocessableEntity)
			w.Write([]byte("could not parse JSON"))
			return
		}

		initFirebase()
		ctx := context.Background()

		// Use a RFC3339 formatted timestamp, rounded to a single minute.
		timestamp := time.Now().UTC().Round(time.Minute)

		// Read IP address, but make it less precise.
		obfuscatedIP, err := getObfuscatedIP(r)
		if err != nil {
			log.Fatalln(err)
		}

		ref, _, err := firestoreClient.Collection("shared").Add(ctx, map[string]interface{}{
			"time": timestamp,
			"ip":   obfuscatedIP,
			"data": data,
		})
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte("could not store data"))
			fmt.Fprintln(os.Stderr, "could not store data:", err)
			return
		}

		// Return a JSON object. Not because we need it right now (we're just
		// returning an ID), but it makes the API extensible in the future.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"id": ref.ID,
		})
	}
}

// Obtain an obfuscated IP address, with the last bits removed to preserve
// privacy.
func getObfuscatedIP(r *http.Request) (string, error) {
	var address netip.Addr
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		// Running inside Google Cloud Run (or behind a reverse proxy anyway).
		// Parse the last IP address in the comma-separated list, because that's
		// the one that's added by Google Cloud Run.
		parts := strings.Split(forwarded, ",")
		var err error
		address, err = netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1]))
		if err != nil {
			return "", fmt.Errorf("could not parse X-Forwarded-For header: %w", err)
		}
	} else {
		// Running locally.
		addrport, err := netip.ParseAddrPort(r.RemoteAddr)
		if err != nil {
			return "", fmt.Errorf("could not parse r.RemoteAddr: %w", err)
		}
		address = addrport.Addr()
	}
	if address.Is4() {
		// clear last octet
		ip := address.As4()
		ip[3] = 0
		return netip.AddrFrom4(ip).String() + "/24", nil
	} else { // IPv6
		// Zero all but the first 3 octets, to make it a /48 address.
		// We might want to consider redacting the address a bit more, since
		// this still identifies a single ISP customer.
		ip := address.As16()
		for i := 6; i < 16; i++ {
			ip[i] = 0
		}
		return netip.AddrFrom16(ip).String() + "/48", nil
	}
}

// Track a single compiler action.
func trackCompile(data map[string]any, modified string) {
	initFirebase()
	ctx := context.Background()

	// Calculate ID for this data point.
	buf, err := json.Marshal(data)
	if err != nil {
		log.Println("ERROR: could not marshal tracking data:", err)
		return
	}
	hash := sha256.Sum256(buf)
	id := base64.URLEncoding.EncodeToString(hash[:])[:20] // same length as standard IDs

	// Add to the right counter. We track initial (unmodified) and modified
	// buffers separately.
	switch modified {
	case "false":
		data["count_initial"] = firestore.Increment(1)
		data["count_modified"] = firestore.Increment(0)
	case "true":
		data["count_initial"] = firestore.Increment(0)
		data["count_modified"] = firestore.Increment(1)
	default:
		// No valid "modified" parameter given, so can't track.
		return
	}

	_, err = firestoreClient.Collection("track").Doc(id).Set(ctx, data, firestore.MergeAll)
	if err != nil {
		log.Printf("tracker: %s", err)
	}
}

// Return recent compilation stats.
func getStats(w http.ResponseWriter, r *http.Request) {
	initFirebase()
	ctx := context.Background()

	// Query data of the past 30 days.
	const numDays = 30
	now := time.Now().UTC().Truncate(time.Hour * 24)
	start := now.Add(-time.Hour * 24 * numDays)
	end := now
	iter := firestoreClient.Collection("track").Where("timestamp", ">=", start).Where("timestamp", "<", end).Documents(ctx)
	defer iter.Stop()

	// Request all data.
	allData := []map[string]any{}
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte("could not fetch stats data"))
			fmt.Fprintln(os.Stderr, "could not fetch data:", err)
			return
		}
		allData = append(allData, doc.Data())
	}

	// Send the data to the client.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(allData)
}
