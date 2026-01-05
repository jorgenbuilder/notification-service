export const idlFactory = ({IDL}) => {
    const Subscription = IDL.Record({
        'endpoint': IDL.Text,
        'keys': IDL.Record({'auth': IDL.Text, 'p256dh': IDL.Text}),
        'expirationTime': IDL.Opt(IDL.Nat),
    });
    const NotificationCanister = IDL.Service({
        'getVapidPublicKey': IDL.Func([], [IDL.Text], ['query']),
        'hasSubscription' : IDL.Func(
            [IDL.Principal, IDL.Text],
            [IDL.Bool],
            ['query'],
        ),
        'subscribe': IDL.Func([IDL.Principal, Subscription], [], ['oneway']),
        'unsubscribe': IDL.Func([IDL.Principal, IDL.Text], [], ['oneway']),
        'unsubscribeAll': IDL.Func([IDL.Principal], [], ['oneway']),
    });
    return NotificationCanister;
};
export const init = ({IDL}) => {
    return [IDL.Principal];
};
