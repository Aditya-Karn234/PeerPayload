#pragma once

// The sender's and receiver's whole programs, as functions. The sender and
// receiver executables are thin main() wrappers around these, and the
// engine library (engine/) calls them in-process for the apps that can't
// spawn processes (Android). One implementation, one set of flags and
// events, whichever way it's run.
int runSenderMain(int argc, char **argv);
int runReceiverMain(int argc, char **argv);
