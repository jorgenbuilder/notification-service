export const idlFactory = ({IDL}) => {
    const RelayerInfo = IDL.Record({
        'relayer': IDL.Principal,
        'description': IDL.Text,
        'lastUpdatedAt': IDL.Nat64,
        'vapid_public_key': IDL.Text,
        'registeredAt': IDL.Nat64,
    });
    const EncryptedNotification = IDL.Record({
        'context': IDL.Tuple(IDL.Principal, IDL.Principal),
        'endpoint': IDL.Text,
        'encrypted': IDL.Opt(
            IDL.Record({
                'cipherText': IDL.Vec(IDL.Nat8),
                'salt': IDL.Vec(IDL.Nat8),
                'localPublicKey': IDL.Vec(IDL.Nat8),
            })
        ),
        'contentEncoding': IDL.Variant({
            'aesgcm': IDL.Null,
            'aes128gcm': IDL.Null,
        }),
    });
    const NotificationBody = IDL.Record({
        'tag': IDL.Opt(IDL.Text),
        'url': IDL.Opt(IDL.Text),
        'title': IDL.Text,
        'content': IDL.Text,
    });
    const SubscriptionKeys = IDL.Record({
        'auth': IDL.Text,
        'p256dh': IDL.Text,
    });
    const Subscription = IDL.Record({
        'endpoint': IDL.Text,
        'keys': SubscriptionKeys,
        'relayer': IDL.Principal,
        'expirationTime': IDL.Opt(IDL.Nat),
    });
    return IDL.Service({
        'getVapidPublicKey': IDL.Func([IDL.Principal], [IDL.Text], ['query']),
        'hasSubscription': IDL.Func(
            [IDL.Principal, IDL.Text],
            [IDL.Bool],
            ['query'],
        ),
        'listRelayers': IDL.Func([], [IDL.Vec(RelayerInfo)], ['query']),
        'peekQueue': IDL.Func(
            [IDL.Nat64],
            [
                IDL.Record({
                    'items': IDL.Vec(EncryptedNotification),
                    'drained': IDL.Bool,
                }),
            ],
            ['query'],
        ),
        'popQueue': IDL.Func([IDL.Nat64], [], []),
        'registerRelayer': IDL.Func([IDL.Principal, IDL.Text, IDL.Text], [], []),
        'reportBrokenSubscriptions': IDL.Func(
            [
                IDL.Vec(
                    IDL.Record({
                        'application': IDL.Principal,
                        'endpoint': IDL.Text,
                        'user': IDL.Principal,
                    })
                ),
            ],
            [],
            [],
        ),
        'sendNotifications': IDL.Func(
            [IDL.Vec(IDL.Tuple(IDL.Principal, NotificationBody))],
            [IDL.Vec(IDL.Bool)],
            [],
        ),
        'subscribe': IDL.Func([IDL.Principal, Subscription], [], []),
        'unsubscribe': IDL.Func([IDL.Principal, IDL.Text], [], []),
        'unsubscribeAll': IDL.Func([IDL.Principal], [], []),
        'updateRelayer': IDL.Func([IDL.Text, IDL.Text], [], []),
    });
};
export const init = ({IDL}) => {
    return [];
};
